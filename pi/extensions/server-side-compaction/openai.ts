import { createHash } from "node:crypto";
import type { Model, Api, Usage } from "@earendil-works/pi-ai";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

type ModelLike = { provider: string; api?: string; id: string; baseUrl?: string; headers?: Record<string, string | null | undefined> };
export interface Adapter { kind: "openai" | "codex"; endpoint: string }
export interface Compatibility { provider: string; api: string; model: string; endpoint: string; accountFingerprint: string }
export class CompactionEndpointError extends Error {
  constructor(public readonly code: "unsupported" | "auth" | "network" | "http" | "response" | "limit" | "timeout" | "aborted", message: string, public readonly status?: number) {
    super(message); this.name = code === "aborted" ? "AbortError" : "CompactionEndpointError";
  }
}
const fail = (code: ConstructorParameters<typeof CompactionEndpointError>[0], message: string): never => { throw new CompactionEndpointError(code, message); };
const object = (value: unknown): Record<string, unknown> | undefined => value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
const nonempty = (v: unknown): v is string => typeof v === "string" && v.length > 0;

/** Deliberately exact host AND path allowlist: custom proxies/Azure are not adapters. */
export function getAdapter(model: ModelLike | undefined): Adapter | undefined {
  if (!model) return;
  const kind = model.provider === "openai" && model.api === "openai-responses" ? "openai" : model.provider === "openai-codex" && model.api === "openai-codex-responses" ? "codex" : undefined;
  if (!kind) return;
  let url: URL;
  try { url = new URL(model.baseUrl || (kind === "openai" ? "https://api.openai.com/v1" : "https://chatgpt.com/backend-api")); } catch { return; }
  if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash || url.port) return;
  const path = url.pathname.replace(/\/$/, "");
  if (kind === "openai" && url.hostname === "api.openai.com" && ["/v1", "/v1/responses"].includes(path)) return { kind, endpoint: "https://api.openai.com/v1/responses/compact" };
  if (kind === "codex" && url.hostname === "chatgpt.com" && ["/backend-api", "/backend-api/codex", "/backend-api/codex/responses"].includes(path)) return { kind, endpoint: "https://chatgpt.com/backend-api/codex/responses/compact" };
}
function accountFromToken(token: string): string | undefined {
  try {
    const payload = object(JSON.parse(Buffer.from(token.split(".")[1] ?? "", "base64url").toString("utf8")));
    const account = object(payload?.["https://api.openai.com/auth"])?.chatgpt_account_id;
    return typeof account === "string" && /^[\w-]{1,256}$/.test(account) ? account : undefined;
  } catch { return; }
}
const hash = (value: string) => createHash("sha256").update("pi-server-compaction.v1\0").update(value).digest("hex");
export function compareCompatibility(a: Compatibility, b: Compatibility): boolean {
  return ["provider", "api", "model", "endpoint", "accountFingerprint"].every(key => a[key as keyof Compatibility] === b[key as keyof Compatibility]);
}
export async function resolveCompactionAuth(ctx: Pick<ExtensionContext, "modelRegistry">, model: ModelLike): Promise<{ adapter: Adapter; headers: Headers; compatibility: Compatibility }> {
  let adapter = getAdapter(model);
  if (!adapter) return fail("unsupported", "Model does not use a supported official OpenAI Responses endpoint.");
  let auth: Awaited<ReturnType<ExtensionContext["modelRegistry"]["getApiKeyAndHeaders"]>>;
  try { auth = await ctx.modelRegistry.getApiKeyAndHeaders(model as Model<Api>); } catch { return fail("auth", "Could not resolve compaction credentials; check /login or API key configuration."); }
  if (!auth.ok || !nonempty(auth.apiKey)) return fail("auth", "No compaction credentials; check /login or API key configuration.");
  if (auth.baseUrl !== undefined) {
    adapter = getAdapter({ ...model, baseUrl: auth.baseUrl });
    if (!adapter) return fail("unsupported", "Resolved authentication uses an unsupported endpoint.");
  }
  if (auth.env && Object.keys(auth.env).length) return fail("unsupported", "Compaction cannot apply provider-specific transport environment overrides; using Pi.");
  const headers = new Headers();
  try {
    for (const source of [model.headers, auth.headers]) for (const [key, value] of Object.entries(source ?? {})) {
      if (value === undefined || value === null) headers.delete(key); else headers.set(key, value);
    }
  } catch { return fail("auth", "Invalid model authentication headers."); }
  // Never accept model-supplied routing/framing headers which could redirect credentials.
  for (const key of ["host", "content-length", "transfer-encoding", "connection", "proxy-authorization"]) headers.delete(key);
  const account = adapter.kind === "codex" ? accountFromToken(auth.apiKey) : undefined;
  if (adapter.kind === "codex" && !account) return fail("auth", "Codex compaction requires a compatible ChatGPT login; reconnect with /login.");
  headers.set("authorization", `Bearer ${auth.apiKey}`);
  headers.set("content-type", "application/json"); headers.set("accept", "application/json");
  if (account) { headers.set("chatgpt-account-id", account); if (!headers.has("originator")) headers.set("originator", "pi"); }
  // API-key identity intentionally changes on key rotation; OAuth identity survives refresh.
  const identity = account ? `codex:${account}` : `key:${auth.apiKey}`;
  const scope = [headers.get("openai-organization"), headers.get("openai-project")];
  return { adapter, headers, compatibility: { provider: model.provider, api: model.api!, model: model.id, endpoint: adapter.endpoint, accountFingerprint: hash(JSON.stringify([identity, ...scope])) } };
}

function validContent(part: unknown): boolean {
  const p = object(part);
  if (!p) return false;
  switch (p.type) {
    case "input_text": case "output_text": case "text": case "summary_text": return typeof p.text === "string";
    case "refusal": return typeof p.refusal === "string";
    case "input_image": return nonempty(p.image_url) || nonempty(p.file_id);
    case "input_file": return nonempty(p.file_id) || nonempty(p.file_data) || nonempty(p.file_url);
    default: return false;
  }
}
/** Supported replayable item variants only. Unknown variants fail closed, never disappear. */
export function validateOutput(value: unknown): unknown[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > 100_000) return fail("response", "Compaction returned an invalid output bundle.");
  let encrypted = 0;
  for (const item of value) {
    const i = object(item);
    if (!i || (i.id !== undefined && !nonempty(i.id)) || (i.status !== undefined && i.status !== "completed")) return fail("response", "Compaction returned an invalid output item.");
    let valid = false;
    switch (i.type ?? (i.role ? "message" : undefined)) {
      case "compaction": valid = nonempty(i.encrypted_content); encrypted++; break;
      case "message": valid = ["user", "assistant", "system", "developer"].includes(i.role as string) && (typeof i.content === "string" || Array.isArray(i.content) && i.content.every(validContent)); break;
      case "reasoning": valid = Array.isArray(i.summary) && i.summary.every(validContent) && (i.encrypted_content === undefined || i.encrypted_content === null || typeof i.encrypted_content === "string"); break;
      case "function_call": valid = nonempty(i.call_id) && nonempty(i.name) && typeof i.arguments === "string"; break;
      case "function_call_output": valid = nonempty(i.call_id) && (typeof i.output === "string" || Array.isArray(i.output) && i.output.every(validContent)); break;
      case "custom_tool_call": valid = nonempty(i.call_id) && nonempty(i.name) && typeof i.input === "string"; break;
      case "custom_tool_call_output": valid = nonempty(i.call_id) && typeof i.output === "string"; break;
    }
    if (!valid) return fail("response", "Compaction returned an unsupported or malformed output item.");
  }
  if (encrypted !== 1) return fail("response", "Compaction must return exactly one encrypted checkpoint.");
  return value; // Entire bundle, original order and objects; no lossy projection.
}
const count = (v: unknown): v is number => typeof v === "number" && Number.isSafeInteger(v) && v >= 0;
export function normalizeUsage(value: unknown, model: Pick<Model<Api>, "cost">): Usage | undefined {
  if (value === undefined || value === null) return;
  const u = object(value);
  if (!u || !count(u.input_tokens) || !count(u.output_tokens) || !count(u.total_tokens) || u.total_tokens !== u.input_tokens + u.output_tokens) return fail("response", "Compaction returned invalid usage.");
  const details = u.input_tokens_details === undefined ? undefined : object(u.input_tokens_details);
  const outputDetails = u.output_tokens_details === undefined ? undefined : object(u.output_tokens_details);
  const cached = details?.cached_tokens ?? 0;
  const written = details?.cache_write_tokens ?? 0;
  const reasoning = outputDetails?.reasoning_tokens;
  if ((u.input_tokens_details !== undefined && !details) || (u.output_tokens_details !== undefined && !outputDetails) || !count(cached) || !count(written) || cached + written > u.input_tokens || (reasoning !== undefined && (!count(reasoning) || reasoning > u.output_tokens))) return fail("response", "Compaction returned invalid usage details.");
  const usage: Usage = { input: u.input_tokens - cached - written, output: u.output_tokens, cacheRead: cached, cacheWrite: written, totalTokens: u.total_tokens, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
  if (reasoning !== undefined) usage.reasoning = reasoning as number;
  // Host model catalogue prices are USD / million tokens; no inferred usage when absent.
  if (!model.cost || ![model.cost.input, model.cost.output, model.cost.cacheRead, model.cost.cacheWrite].every(n => typeof n === "number" && Number.isFinite(n) && n >= 0)) return fail("response", "Model pricing unavailable for compaction accounting.");
  usage.cost.input = usage.input * model.cost.input / 1_000_000;
  usage.cost.output = usage.output * model.cost.output / 1_000_000;
  usage.cost.cacheRead = cached * model.cost.cacheRead / 1_000_000;
  usage.cost.cacheWrite = written * model.cost.cacheWrite / 1_000_000;
  usage.cost.total = usage.cost.input + usage.cost.output + usage.cost.cacheRead + usage.cost.cacheWrite;
  return usage;
}

export interface CompactPrefixOptions {
  ctx: Pick<ExtensionContext, "modelRegistry">;
  model: Model<Api>;
  /** Already serialized provider-visible older prefix. This adapter never normalizes it. */
  input: unknown[];
  instructions?: string;
  signal?: AbortSignal;
  timeoutMs?: number;
  maxResponseBytes?: number;
  fetch?: typeof fetch;
  /** Only API-key OpenAI's documented unary cache routing fields; Codex omits them. */
  prompt_cache_key?: string;
  prompt_cache_retention?: "in_memory" | "24h";
}
export async function compactPrefix(options: CompactPrefixOptions): Promise<{ output: unknown[]; usage?: Usage; compatibility: Compatibility }> {
  const { ctx, model, signal } = options;
  const timeoutMs = options.timeoutMs ?? 120_000;
  const maxBytes = options.maxResponseBytes ?? 32 * 1024 * 1024;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 600_000 || !Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > 128 * 1024 * 1024) return fail("limit", "Invalid compaction request limits.");
  if (!Array.isArray(options.input) || options.input.length === 0) return fail("response", "Compaction requires a nonempty structured prefix.");
  const controller = new AbortController();
  let timedOut = false;
  const abort = () => controller.abort();
  signal?.addEventListener("abort", abort, { once: true });
  if (signal?.aborted) abort();
  const timer = setTimeout(() => { timedOut = true; controller.abort(); }, timeoutMs);
  // Race also bounds non-cooperative mocks, auth resolution, and stalled body readers.
  let onAbort: (() => void) | undefined;
  const cancelled = new Promise<never>((_, reject) => {
    onAbort = () => reject(new CompactionEndpointError(signal?.aborted ? "aborted" : "timeout", signal?.aborted ? "Compaction cancelled." : "Compaction request timed out."));
    controller.signal.addEventListener("abort", onAbort, { once: true });
    if (controller.signal.aborted) onAbort();
  });
  const work = async () => {
    const auth = await resolveCompactionAuth(ctx, model);
    if (controller.signal.aborted) return fail(signal?.aborted ? "aborted" : "timeout", "Compaction cancelled or timed out.");
    const body: Record<string, unknown> = { model: model.id, input: options.input };
    if (options.instructions !== undefined) body.instructions = options.instructions;
    if (auth.adapter.kind === "openai") {
      if (options.prompt_cache_key !== undefined) body.prompt_cache_key = options.prompt_cache_key;
      if (options.prompt_cache_retention !== undefined) body.prompt_cache_retention = options.prompt_cache_retention;
    }
    let response: Response;
    try {
      response = await (options.fetch ?? fetch)(auth.adapter.endpoint, { method: "POST", redirect: "error", signal: controller.signal, headers: auth.headers, body: JSON.stringify(body) });
    } catch { return fail("network", "Could not reach the compaction endpoint."); }
    if (controller.signal.aborted) { void response.body?.cancel().catch(() => {}); return fail(signal?.aborted ? "aborted" : "timeout", "Compaction cancelled or timed out."); }
    if (!response.ok || response.redirected) {
      void response.body?.cancel().catch(() => {});
      throw new CompactionEndpointError("http", `Compaction endpoint failed (HTTP ${response.status}).`, response.status);
    }
    const declared = response.headers.get("content-length");
    if (declared && /^\d+$/.test(declared) && Number(declared) > maxBytes) { void response.body?.cancel().catch(() => {}); return fail("limit", "Compaction response exceeded the configured byte limit."); }
    if (!response.body) return fail("response", "Compaction returned an empty response.");
    const reader = response.body.getReader();
    const cancelReader = () => { void reader.cancel().catch(() => {}); };
    controller.signal.addEventListener("abort", cancelReader, { once: true });
    const chunks: Uint8Array[] = [];
    let size = 0;
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > maxBytes) { cancelReader(); return fail("limit", "Compaction response exceeded the configured byte limit."); }
        chunks.push(value);
      }
    } finally { controller.signal.removeEventListener("abort", cancelReader); reader.releaseLock(); }
    let parsed: Record<string, unknown> | undefined;
    try { parsed = object(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks)))); } catch { return fail("response", "Compaction returned invalid JSON."); }
    if (!parsed || parsed.object !== "response.compaction") return fail("response", "Compaction returned an unrecognized response envelope.");
    return { output: validateOutput(parsed.output), usage: normalizeUsage(parsed.usage, model), compatibility: auth.compatibility };
  };
  try { return await Promise.race([work(), cancelled]); }
  catch (error) {
    if (signal?.aborted) return fail("aborted", "Compaction cancelled.");
    if (timedOut) return fail("timeout", "Compaction request timed out.");
    if (error instanceof CompactionEndpointError) throw error;
    return fail("response", "Compaction request failed while processing its response.");
  } finally {
    clearTimeout(timer); signal?.removeEventListener("abort", abort);
    if (onAbort) controller.signal.removeEventListener("abort", onAbort);
  }
}
