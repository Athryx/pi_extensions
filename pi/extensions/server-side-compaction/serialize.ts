import { randomUUID } from "node:crypto";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { getCurrentSystemMessage, getSystemMessageText, openAIResponsesApi, openAICodexResponsesApi, type Api, type Model } from "@earendil-works/pi-ai";
import { buildSessionProjection, convertToLlm, type ExtensionContext, type SessionEntry } from "@earendil-works/pi-coding-agent";

export type Payload = Record<string, any>;
const text = (item: any): string => typeof item?.content === "string" ? item.content : Array.isArray(item?.content)
  ? item.content.map((part: any) => typeof part?.text === "string" ? part.text : "").join("") : "";

/** Replace only a checkpoint's synthetic summary item; never inspect/decode ciphertext. */
export function replay(payload: Payload, marker: string, output: unknown[]): Payload {
  if (!Array.isArray(payload?.input)) throw new Error("Provider payload has no structured input for the encrypted checkpoint.");
  const hits = payload.input.flatMap((item: any, index: number) => item?.role === "user" && text(item).includes(marker) ? [index] : []);
  if (hits.length !== 1) throw new Error("Could not identify the encrypted checkpoint summary exactly once.");
  const input = [...payload.input];
  input.splice(hits[0], 1, ...structuredClone(output));
  // A changed prefix cannot be replayed through a provider's old response chain.
  const next: Payload = { ...payload, input };
  delete next.previous_response_id;
  return next;
}

/** A poison value fails inside the provider, not inside the fail-open event runner. */
export function blockedPayload(reason: string): Payload {
  const fail = (): never => { throw new Error(reason); };
  return new Proxy(Object.create(null), {
    // Async hooks and the runner await this result. Promise assimilation must
    // succeed; otherwise Pi catches the hook error and sends the old payload.
    get: (_target, key) => key === "then" ? undefined : fail(),
    ownKeys: fail, getOwnPropertyDescriptor: fail,
  });
}

/** Use the real provider's payload builder, stopping before any HTTP/WebSocket operation. */
export async function capturePayload(model: Model<Api>, messages: AgentMessage[], options: { sessionId?: string; signal?: AbortSignal } = {}): Promise<Payload> {
  const serialize = model.api === "openai-responses" ? openAIResponsesApi().streamSimple : model.api === "openai-codex-responses" ? openAICodexResponsesApi().streamSimple : undefined;
  if (!serialize) throw new Error("No supported Responses serializer for this model.");
  let captured: Payload | undefined;
  await serialize(model as never, { messages: convertToLlm(messages) } as never, {
    // Codex validates the JWT account claim before building a payload. This is
    // deliberately synthetic and never leaves this no-network serialization call.
    apiKey: model.api === "openai-codex-responses"
      ? `h.${Buffer.from(JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "serialization-only" } })).toString("base64url")}.s`
      : "sk-serialization-only",
    transport: "sse", sessionId: options.sessionId, signal: options.signal,
    fetch: async () => { throw new Error("Serialization must not perform network requests."); },
    onPayload(payload: unknown) {
      captured = structuredClone(payload as Payload);
      throw new Error("Payload captured; no request was sent.");
    },
  }).result();
  if (options.signal?.aborted) throw new Error("Compaction cancelled.");
  if (!captured || !Array.isArray(captured.input)) throw new Error("Could not build structured compaction input without a request.");
  return captured;
}

/** Serialize the full projection with a boundary anchor, then keep only its original prefix.
 * Folding later system/tool state happens exactly as it does for normal generation.
 * The random anchor is never sent over the network or persisted.
 */
export async function serializePrefix(ctx: ExtensionContext, model: Model<Api>, branch: SessionEntry[], firstKeptEntryId: string,
  previous?: { marker: string; output: unknown[]; portable?: string }, signal?: AbortSignal): Promise<Payload> {
  const projection = buildSessionProjection(branch);
  const cut = projection.entries.findIndex(entry => entry.sourceEntry.id === firstKeptEntryId);
  if (cut < 0) throw new Error("Compaction retention boundary is missing from the active context.");
  const anchor = `pi-compaction-boundary-${randomUUID()}`;
  let messages: AgentMessage[] = projection.entries.flatMap((entry, index) => [
    ...(index === cut ? [{ role: "user", content: anchor, timestamp: Date.now() } as AgentMessage] : []),
    ...entry.messages.filter(m => !(m.role === "custom" && m.customType === "server-side-compaction.portable.v1")), 
  ]);
  const current = getCurrentSystemMessage(convertToLlm(messages));
  const prompt = ctx.getSystemPrompt();
  if (current && getSystemMessageText(current) !== prompt) {
    // Forced prompts own the leading prompt for generation too. Keep final tools.
    messages = [{ ...current, content: prompt, sections: undefined } as AgentMessage, ...messages.filter(m => m.role !== "system")];
  } else if (!current) {
    messages.unshift({ role: "system", content: prompt, timestamp: 0 } as AgentMessage);
  }
  const payload = await capturePayload(model, messages, { sessionId: ctx.sessionManager.getSessionId(), signal });
  const boundaries = payload.input.flatMap((item: any, index: number) => item?.role === "user" && text(item) === anchor ? [index] : []);
  if (boundaries.length !== 1) throw new Error("Could not identify compaction's structured prefix boundary.");
  const prefix = { ...payload, input: payload.input.slice(0, boundaries[0]) };
  if (previous) return replay(prefix, previous.marker, previous.portable
    ? [{ role: "user", content: [{ type: "input_text", text: previous.portable }] }] : previous.output);
  return prefix;
}

/** Conservative safety check; never shorten original contents to make server compaction fit. */
export function assertPrefixBudget(payload: Payload, model: Model<Api>): void {
  const estimate = Math.ceil(JSON.stringify(payload.input).length / 3) + Math.ceil((payload.instructions?.length ?? 0) / 3);
  if (model.contextWindow > 0 && estimate >= model.contextWindow) throw new Error("Original structured prefix exceeds the conservative server input budget; using Pi.");
}
