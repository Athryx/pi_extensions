import { randomUUID } from "node:crypto";
import type { Api, Model } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext, SessionBeforeCompactEvent } from "@earendil-works/pi-coding-agent";
import { isWorkerSession } from "../shared/agent-role.ts";
import { DEFAULT_CONFIG, isMode, loadConfig, resolvePolicy, type Config } from "./config.ts";
import { checkpoint, markerForCheckpoint, reconstructPrefix } from "./checkpoint.ts";
import { getMode, MODE_ENTRY, PORTABLE_ENTRY } from "./state.ts";
import { CompactionEndpointError, compactPrefix, compareCompatibility, getAdapter, resolveCompactionAuth, type Compatibility } from "./openai.ts";
import { assertPrefixBudget, blockedPayload, replay, serializePrefix, type Payload } from "./serialize.ts";
import { compactReadable, readableSummary } from "./summarize.ts";

const NOTICE = "server-side-compaction.notice.v1";
// Provider failures are untrusted even when prefixed with a familiar word.
const safeError = (error: unknown): string => error instanceof CompactionEndpointError
  ? error.message : "Compaction operation failed; original checkpoint was preserved. Check source history, model/account compatibility, configuration and request routing.";

export default function (pi: ExtensionAPI) {
  // Factories are session-scoped, including when subagents share jiti's module cache.
  let config: Config = { ...DEFAULT_CONFIG };
  let epoch = 0;
  let operation: AbortController | undefined;
  let lifetime = new AbortController();
  let restoringModel: Model<Api> | undefined;
  let switchRevision = 0;
  let switching = false;
  let guardError: string | undefined;

  function notice(ctx: ExtensionContext, message: string, level: "info" | "warning" | "error" = "info") {
    if (ctx.hasUI) ctx.ui.notify(message, level);
    else pi.appendEntry(NOTICE, { level, message }); // no stdout JSON corruption or prompt pollution
  }
  function state(ctx: ExtensionContext) { return checkpoint(ctx.sessionManager.getBranch()); }
  function render(ctx: ExtensionContext) {
    if (ctx.mode !== "tui") return;
    const selected = resolvePolicy(ctx.model, config, getMode(ctx.sessionManager.getBranch()));
    ctx.ui.setStatus("server-side-compaction", `compact: ${selected.mode} → ${selected.backend}`);
  }
  const cancelOperation = () => {
    epoch++; switchRevision++; switching = false; operation?.abort(); operation = undefined;
    lifetime.abort(); lifetime = new AbortController(); guardError = undefined;
  };
  async function restore(ctx: ExtensionContext) {
    cancelOperation();
    const current = epoch;
    const loaded = await loadConfig(ctx);
    if (current !== epoch) return;
    config = loaded.config;
    for (const warning of loaded.warnings) notice(ctx, warning, "warning");
    render(ctx);
  }
  async function compatible(ctx: ExtensionContext, model: Model<Api> | undefined, key: Compatibility): Promise<boolean> {
    if (!model || !getAdapter(model)) return false;
    const signal = AbortSignal.any([lifetime.signal, AbortSignal.timeout(config.timeoutMs)]);
    if (signal.aborted) return false;
    let onAbort: () => void = () => {};
    try {
      const aborted = new Promise<never>((_resolve, reject) => {
        onAbort = () => reject(new Error("Compaction compatibility check cancelled."));
        signal.addEventListener("abort", onAbort, { once: true });
      });
      const auth = await Promise.race([resolveCompactionAuth(ctx, model), aborted]);
      return compareCompatibility(key, auth.compatibility);
    } catch { return false; }
    finally { signal.removeEventListener("abort", onAbort); }
  }

  async function portable(ctx: ExtensionContext, model: Model<Api>) {
    if (operation) throw new Error("Compaction conversion is already running.");
    if (!ctx.isIdle()) throw new Error("Compaction conversion requires an idle session.");
    const active = state(ctx);
    if (!active || active.portable) return;
    const controller = new AbortController(); operation = controller;
    const generation = epoch, session = ctx.sessionManager.getSessionId(), leaf = ctx.sessionManager.getLeafId();
    try {
      const messages = reconstructPrefix(ctx.sessionManager.getBranch(), active.data.source.firstKeptEntryId);
      // Registry-owned nested calls do not traverse the session request hooks;
      // never disable generation guards globally while this call is pending.
      const result = await readableSummary(ctx, model, messages, controller.signal);
      if (controller.signal.aborted || epoch !== generation || session !== ctx.sessionManager.getSessionId() || leaf !== ctx.sessionManager.getLeafId()) throw new Error("Compaction conversion became stale after session history changed.");
      // A model-visible message, rather than only state metadata, makes conversion
      // survive disabling this extension. While loaded, context() moves it to the summary slot.
      pi.sendMessage({ customType: PORTABLE_ENTRY, display: true,
        content: result.text, details: { checkpointId: active.entry.id, summary: result.text, usage: result.usage,
          accounting: "standalone conversion usage is not included in Pi native cost totals" } }, { triggerTurn: false });
      notice(ctx, "Portable readable checkpoint saved. Standalone conversion usage is recorded in checkpoint details, not Pi's native cost totals.");
    } finally { if (operation === controller) operation = undefined; }
  }

  pi.registerCommand("compaction", {
    description: "Compaction backend: auto | pi | server | reset | status | portable",
    handler: async (args, ctx) => {
      const action = args.trim() || "status";
      if (operation) { notice(ctx, "Compaction conversion is already running.", "warning"); return; }
      if (isMode(action) || action === "reset") {
        pi.appendEntry(MODE_ENTRY, { mode: action === "reset" ? null : action }); render(ctx);
        notice(ctx, "Next compaction policy updated; the current checkpoint is unchanged."); return;
      }
      if (action === "status") {
        try {
          const active = state(ctx);
          const policy = resolvePolicy(ctx.model, config, getMode(ctx.sessionManager.getBranch()));
          notice(ctx, `Compaction: ${policy.mode} → ${policy.backend} (${policy.reason}). Current checkpoint: ${active ? active.portable ? "portable readable" : "encrypted" : "Pi/readable or none"}.`);
        } catch (error) { notice(ctx, safeError(error), "error"); }
        return;
      }
      if (action === "portable") {
        try {
          if (!ctx.model) throw new Error("No model selected for readable conversion.");
          await portable(ctx, ctx.model);
        } catch (error) { notice(ctx, safeError(error), "error"); }
        return;
      }
      notice(ctx, "Usage: /compaction [auto|pi|server|reset|status|portable]", "warning");
    },
  });

  pi.on("session_start", (_event, ctx) => restore(ctx));
  // The host emits session_start after switch/fork; pre-events cancel stale work.
  pi.on("session_before_switch", () => { cancelOperation(); });
  pi.on("session_before_fork", () => { cancelOperation(); });
  pi.on("session_before_tree", () => { cancelOperation(); });
  pi.on("session_tree", (_event, ctx) => restore(ctx));
  pi.on("session_shutdown", (_event, ctx) => { cancelOperation(); if (ctx.mode === "tui") ctx.ui.setStatus("server-side-compaction", undefined); });

  pi.on("context_with_system", (event, ctx) => {
    guardError = undefined;
    try {
      const active = state(ctx);
      if (!active?.portable) return;
      const anchors = event.messages.filter(m => m.role === "compactionSummary" && m.summary === active.entry.summary);
      if (anchors.length !== 1) throw new Error("Could not identify the portable checkpoint summary exactly once.");
      return { messages: event.messages.filter(m => !(m.role === "custom" && m.customType === PORTABLE_ENTRY && (m.details as any)?.checkpointId === active.entry.id))
        .map(m => m === anchors[0] ? { ...m, summary: active.portable!.summary } : m) };
    } catch (error) { guardError = safeError(error); }
  });

  pi.on("before_provider_request", async (event, ctx) => {
    const generation = epoch, leaf = ctx.sessionManager.getLeafId();
    try {
      if (guardError) throw new Error(guardError);
      if (operation) throw new Error("Compaction conversion is pending; generation is blocked.");
      const active = state(ctx);
      if (!active) return;
      const payload = event.payload as Payload;
      if (active.portable) {
        // Some request-local paths bypass context projection (for example a cache
        // refresh). Never send the old marker without its semantic readable text.
        if (JSON.stringify(payload).includes(active.data.marker)) {
          return replay(payload, active.data.marker, [{ role: "user", content: [{ type: "input_text", text: active.portable.summary }] }]);
        }
        return;
      }
      if (payload?.model !== active.data.compatibility.model) throw new Error("Encrypted checkpoint is incompatible with the request's routed model.");
      if (!await compatible(ctx, ctx.model, active.data.compatibility)) throw new Error("Encrypted checkpoint is incompatible with this model/account. Use /compaction portable before switching.");
      if (generation !== epoch || leaf !== ctx.sessionManager.getLeafId() || operation || ctx.signal?.aborted) throw new Error("Compaction request became stale after session history changed.");
      // Never throw in this hook: Pi reports handler errors and otherwise sends the old payload.
      return replay(event.payload as Payload, active.data.marker, active.data.output);
    } catch (error) {
      const message = safeError(error);
      if (generation === epoch) notice(ctx, message, "error");
      return blockedPayload(message);
    }
  });

  pi.on("session_before_compact", async (event, ctx) => {
    if (operation) { notice(ctx, "Compaction conversion is already running.", "warning"); return { cancel: true }; }
    const generation = epoch;
    event = { ...event, signal: AbortSignal.any([event.signal, lifetime.signal]) };
    try {
      const previous = checkpoint(event.branchEntries);
      const selected = resolvePolicy(ctx.model, config, getMode(event.branchEntries));
      const model = ctx.model;
      if (!model) return { cancel: true };
      if (selected.backend === "server") {
        try {
          if (previous && !previous.portable && !await compatible(ctx, model, previous.data.compatibility)) throw new Error("Encrypted checkpoint requires readable conversion before this server can compact it.");
          const payload = await serializePrefix(ctx, model, event.branchEntries, event.preparation.firstKeptEntryId,
            previous ? { ...previous.data, portable: previous.portable?.summary } : undefined, event.signal);
          assertPrefixBudget(payload, model);
          const instructions = event.customInstructions ? `${payload.instructions ?? ""}\n\nCompaction focus: ${event.customInstructions}`.trim() : payload.instructions;
          const result = await compactPrefix({ ctx, model, input: payload.input, instructions, signal: event.signal,
            timeoutMs: config.timeoutMs, maxResponseBytes: config.maxResponseBytes,
            prompt_cache_key: payload.prompt_cache_key, prompt_cache_retention: payload.prompt_cache_retention });
          if (event.signal.aborted || generation !== epoch) return { cancel: true };
          const marker = markerForCheckpoint(randomUUID());
          const cut = event.branchEntries.findIndex(e => e.id === event.preparation.firstKeptEntryId);
          if (cut <= 0) throw new Error("Missing source history for encrypted checkpoint.");
          return { compaction: { summary: marker, firstKeptEntryId: event.preparation.firstKeptEntryId, tokensBefore: event.preparation.tokensBefore,
            usage: result.usage, details: { kind: "server-side-compaction", version: 1, marker, compatibility: result.compatibility, output: result.output,
              source: { firstKeptEntryId: event.preparation.firstKeptEntryId, summarizedThroughEntryId: event.branchEntries[cut - 1].id },
              readFiles: [...new Set([...event.preparation.fileOps.read, ...(previous?.data.readFiles ?? [])])]
                .filter(path => !event.preparation.fileOps.written.has(path) && !event.preparation.fileOps.edited.has(path) && !previous?.data.modifiedFiles.includes(path)),
              modifiedFiles: [...new Set([...event.preparation.fileOps.written, ...event.preparation.fileOps.edited, ...(previous?.data.modifiedFiles ?? [])])] } } };
        } catch (error) {
          if (event.signal.aborted || generation !== epoch) return { cancel: true };
          notice(ctx, `${safeError(error)} Falling back to regular Pi compaction.`, "warning");
        }
      } else if (selected.mode === "server") notice(ctx, `${selected.reason} Using regular Pi compaction.`, "warning");
      if (!previous) return; // native Pi owns the ordinary path, including retries/settings
      const result = await compactReadable(ctx, model, event as SessionBeforeCompactEvent);
      if (event.signal.aborted || generation !== epoch) return { cancel: true };
      return { compaction: result };
    } catch (error) {
      // Native fallthrough here could summarize a marker and lose the encrypted history.
      if (generation === epoch) notice(ctx, safeError(error), "error");
      return { cancel: true };
    }
  });

  pi.on("model_select", async (event, ctx) => {
    if (restoringModel?.provider === event.model.provider && restoringModel?.id === event.model.id) return;
    const revision = ++switchRevision;
    const generation = epoch, sessionId = ctx.sessionManager.getSessionId();
    let leaf = ctx.sessionManager.getLeafId();
    const current = () => generation === epoch && revision === switchRevision && sessionId === ctx.sessionManager.getSessionId();
    const unchanged = () => current() && leaf === ctx.sessionManager.getLeafId();
    const wasSwitching = switching;
    try {
      const active = state(ctx);
      if (!active || active.portable) { render(ctx); return; }
      const allowed = await compatible(ctx, event.model, active.data.compatibility);
      if (!unchanged()) return;
      if (allowed) { render(ctx); return; }
      switching = true;
      const target = event.model, previous = event.previousModel;
      const canRestore = previous && await compatible(ctx, previous, active.data.compatibility);
      if (!unchanged()) return;
      if (!previous || !canRestore) {
        notice(ctx, "Encrypted checkpoint is incompatible. Generation is blocked; explicitly run /compaction portable to convert it.", "error"); return;
      }
      // Post-change hook: restore under a model-specific recursion guard. Check
      // identity after EVERY auth/dialog await, before any subsequent mutation.
      restoringModel = previous;
      try { if (!await pi.setModel(previous)) throw new Error("Could not restore the compatible model."); }
      finally { if (restoringModel === previous) restoringModel = undefined; }
      if (!current()) return;
      const branch = ctx.sessionManager.getBranch();
      const oldLeaf = branch.findIndex(entry => entry.id === leaf);
      if (oldLeaf < 0 || branch.slice(oldLeaf + 1).some(entry => entry.type !== "model_change" && entry.type !== "thinking_level_change")) return;
      leaf = ctx.sessionManager.getLeafId();
      if (wasSwitching || operation || !ctx.isIdle() || !ctx.hasUI || isWorkerSession(ctx.sessionManager)) {
        notice(ctx, "Model switch cancelled: encrypted context needs readable compaction. Run /compaction portable explicitly, then switch again.", "warning"); return;
      }
      const accepted = await ctx.ui.confirm("Compaction required to switch model",
        "This thread contains an OpenAI encrypted checkpoint the target model cannot read. Convert it to a readable summary (one or more model calls) and switch? Cancel keeps the previous model. Conversion usage is recorded separately from Pi native cost totals.");
      if (!accepted || !unchanged()) return;
      await portable(ctx, previous);
      if (!current()) return;
      restoringModel = target;
      try { if (!await pi.setModel(target)) notice(ctx, "Could not select the target model; the readable checkpoint is saved.", "error"); }
      finally { if (restoringModel === target) restoringModel = undefined; }
      if (current()) render(ctx);
    } catch (error) { if (current()) notice(ctx, safeError(error), "error"); }
    finally { if (revision === switchRevision) switching = false; }
  });
}
