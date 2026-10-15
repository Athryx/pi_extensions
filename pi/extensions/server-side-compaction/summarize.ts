import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { Api, Model, Usage } from "@earendil-works/pi-ai";
import { compact, convertToLlm, generateSummaryWithUsage, serializeConversation, type CompactionResult, type ExtensionContext, type SessionBeforeCompactEvent } from "@earendil-works/pi-coding-agent";
import { checkpoint, reconstructPrefix } from "./checkpoint.ts";

export function addUsage(a: Usage | undefined, b: Usage | undefined): Usage | undefined {
  if (!a) return b;
  if (!b) return a;
  return { input: a.input + b.input, output: a.output + b.output, cacheRead: a.cacheRead + b.cacheRead,
    cacheWrite: a.cacheWrite + b.cacheWrite, totalTokens: a.totalTokens + b.totalTokens,
    ...(a.reasoning !== undefined || b.reasoning !== undefined ? { reasoning: (a.reasoning ?? 0) + (b.reasoning ?? 0) } : {}),
    cost: { input: a.cost.input + b.cost.input, output: a.cost.output + b.cost.output,
      cacheRead: a.cost.cacheRead + b.cost.cacheRead, cacheWrite: a.cost.cacheWrite + b.cost.cacheWrite, total: a.cost.total + b.cost.total } };
}

/** Keep call/results in one summarization unit; split only oversized plain user text. */
export function summaryChunks(messages: AgentMessage[], budget: number): AgentMessage[][] {
  const units: AgentMessage[][] = [];
  for (const message of messages) {
    if (message.role === "toolResult" && units.length) units.at(-1)!.push(message);
    else units.push([message]);
  }
  const tokens = (group: AgentMessage[]) => Math.ceil(serializeConversation(convertToLlm(group)).length / 3);
  const chunks: AgentMessage[][] = [];
  let chunk: AgentMessage[] = [], size = 0;
  for (const unit of units) {
    const n = tokens(unit);
    if (n > budget) {
      if (chunk.length) { chunks.push(chunk); chunk = []; size = 0; }
      const only = unit[0];
      if (unit.length !== 1 || only.role !== "user" || typeof only.content !== "string") throw new Error("A source message/tool group is too large for safe portability conversion.");
      for (let i = 0; i < only.content.length; i += Math.max(1, (budget - 64) * 3)) chunks.push([{ ...only, content: only.content.slice(i, i + Math.max(1, (budget - 64) * 3)) }]);
      continue;
    }
    if (size + n > budget && chunk.length) { chunks.push(chunk); chunk = []; size = 0; }
    chunk.push(...unit); size += n;
  }
  if (chunk.length) chunks.push(chunk);
  return chunks;
}

export async function readableSummary(ctx: ExtensionContext, model: Model<Api>, messages: AgentMessage[], signal: AbortSignal,
  instructions?: string, reserveTokens = 4096): Promise<{ text: string; usage?: Usage }> {
  const reserve = Math.max(128, Math.min(reserveTokens, model.maxTokens || 4096));
  // Leave room for Pi's summary prompt and the carried-forward output summary.
  const budget = Math.floor((model.contextWindow - reserve * 2 - 4096) * 0.65);
  if (budget < 256) throw new Error("Model context window is too small for safe portability conversion.");
  const chunks = summaryChunks(messages.filter(m => m.role !== "system"), budget);
  if (!chunks.length) throw new Error("Readable checkpoint source history is empty.");
  let text: string | undefined, usage: Usage | undefined;
  for (const chunk of chunks) {
    if (signal.aborted) throw new Error("Compaction cancelled.");
    const result = await generateSummaryWithUsage(chunk, model, reserve, undefined, undefined, signal, instructions, text,
      ctx.thinkingLevel, (_model, context, options) => ctx.modelRegistry.streamSimple(model, context, options));
    if (!result.text.trim()) throw new Error("Portability summarization returned an empty summary.");
    text = result.text; usage = addUsage(usage, result.usage);
  }
  return { text: text!, usage };
}

/** Let Pi's own compactor handle the new span/split turn after hydrating an encrypted prior summary. */
export async function compactReadable(ctx: ExtensionContext, model: Model<Api>, event: SessionBeforeCompactEvent): Promise<CompactionResult> {
  const previous = checkpoint(event.branchEntries);
  let previousSummary = event.preparation.previousSummary;
  let hydrationUsage: Usage | undefined;
  if (previous) {
    if (previous.portable) previousSummary = previous.portable.summary;
    else {
      const hydrated = await readableSummary(ctx, model, reconstructPrefix(event.branchEntries, previous.data.source.firstKeptEntryId), event.signal,
        event.customInstructions, event.preparation.settings.reserveTokens);
      previousSummary = hydrated.text; hydrationUsage = hydrated.usage;
    }
  }
  const fileOps = {
    read: new Set([...event.preparation.fileOps.read, ...(previous?.data.readFiles ?? [])]),
    written: new Set([...event.preparation.fileOps.written, ...(previous?.data.modifiedFiles ?? [])]),
    edited: new Set(event.preparation.fileOps.edited),
  };
  const result = await compact({ ...event.preparation, previousSummary, fileOps }, model, undefined, undefined, event.customInstructions,
    event.signal, ctx.thinkingLevel, (_model, context, options) => ctx.modelRegistry.streamSimple(model, context, options));
  result.usage = addUsage(hydrationUsage, result.usage);
  return result;
}
