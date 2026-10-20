import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

export const PROVIDER_TOOLS_CHANGED = "ui:provider-tools:changed:v1";
const REQUEST = "ui:provider-tools:request:v1";
export const PROVIDER_TOOLS_FIELD = "providerToolCalls";
export type ProviderToolStatus = "running" | "completed" | "error" | "cancelled";
export interface ProviderToolCall { id: string; label: string; summary: string; status: ProviderToolStatus }
export interface ProviderToolCalls { version: 1; calls: ProviderToolCall[] }
export interface ProviderToolUpdate { id: string; label: string; summary: string; status?: ProviderToolStatus }
export interface ProviderToolStream {
  /** False for stale streams, invalid updates, or a full (256-row) response. */
  update(call: ProviderToolUpdate): boolean;
}
export interface ProviderToolReporter { begin(): ProviderToolStream }
interface Service { version: 1; reporter(namespace: string): ProviderToolReporter }
type ToolMessage = AgentMessage & { providerToolCalls?: ProviderToolCalls };
const statuses = new Set(["running", "completed", "error", "cancelled"]);

/** Extension-owned assistant metadata. Providers never receive it as a function call. */
export function providerToolCalls(message: unknown): readonly ProviderToolCall[] {
  const metadata = (message as ToolMessage | undefined)?.providerToolCalls;
  return metadata?.version === 1 && Array.isArray(metadata.calls) ? metadata.calls : [];
}

/** One coordinator per session event bus, shared by any number of provider adapters. */
export function createProviderToolReporter(pi: ExtensionAPI, namespace: string): ProviderToolReporter {
  if (!/^[a-zA-Z0-9][\w./-]{0,127}$/.test(namespace)) throw new Error("Invalid provider tool namespace");
  let found: Service | undefined;
  pi.events.emit(REQUEST, { reply(service: Service) { if (service?.version === 1 && typeof service.reporter === "function") found = service; } });
  if (found) return found.reporter(namespace);

  let current: ProviderToolCalls = { version: 1, calls: [] };
  let active = false;
  let disposed = false;
  const changed = () => pi.events.emit(PROVIDER_TOOLS_CHANGED, undefined);
  const reset = () => { current = { version: 1, calls: [] }; active = false; };
  const finish = (status: ProviderToolStatus) => {
    let updated = false;
    current.calls = current.calls.map(call => {
      if (call.status !== "running") return call;
      updated = true;
      return { ...call, status };
    });
    active = false;
    if (updated) changed();
  };
  const service: Service = { version: 1, reporter(source) {
    return { begin() {
      if (!active && !disposed) { reset(); active = true; }
      const frame = current;
      return { update(update) {
        if (disposed || !active || frame !== current || !update || typeof update.id !== "string" || !update.id || update.id.length > 512
          || typeof update.label !== "string" || !update.label || typeof update.summary !== "string"
          || (update.status !== undefined && !statuses.has(update.status))) return false;
        const id = `${source}:${update.id}`;
        const index = frame.calls.findIndex(call => call.id === id);
        if (index < 0 && frame.calls.length >= 256) return false;
        const before = frame.calls[index];
        const next: ProviderToolCall = { id, label: update.label.slice(0, 120), summary: update.summary.slice(0, 8192), status: update.status ?? before?.status ?? "running" };
        if (before && before.label === next.label && before.summary === next.summary && before.status === next.status) return true;
        // Keep the frame object stable: every live message clone and its UI row
        // shares it even when a provider tool emits no normalized text delta.
        frame.calls = [...frame.calls];
        if (index < 0) frame.calls.push(next); else frame.calls[index] = next;
        changed();
        return true;
      } };
    } };
  } };
  const unsubscribe = pi.events.on(REQUEST, value => {
    const request = value as { reply?: (service: Service) => void } | undefined;
    if (!disposed && typeof request?.reply === "function") request.reply(service);
  });
  pi.on("before_provider_request", () => { reset(); active = true; });
  const attach = (message: AgentMessage) => {
    if (active && message.role === "assistant") (message as ToolMessage).providerToolCalls = current;
  };
  pi.on("message_start", event => attach(event.message));
  pi.on("message_update", event => attach(event.message));
  pi.on("message_end", event => {
    if (event.message.role !== "assistant" || !active) return;
    finish(event.message.stopReason === "error" ? "error" : event.message.stopReason === "aborted" || event.message.stopReason === "length" ? "cancelled" : "completed");
    if (current.calls.length) return { message: { ...event.message, providerToolCalls: current } };
  });
  const invalidate = (_event: unknown, _ctx: ExtensionContext) => reset();
  pi.on("session_start", invalidate);
  pi.on("session_before_switch", invalidate);
  pi.on("session_before_fork", invalidate);
  pi.on("session_before_tree", invalidate);
  pi.on("session_tree", invalidate);
  pi.on("model_select", invalidate);
  pi.on("agent_end", () => { if (active) finish("cancelled"); });
  pi.on("session_shutdown", () => { reset(); disposed = true; unsubscribe(); });
  return service.reporter(namespace);
}
