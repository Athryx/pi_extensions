import { Type } from "typebox";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { conversationMode, isMode, loadConfig, MODE_ENTRY, type Configuration, type Mode } from "./config.ts";
import { searchRequest, supportsSearch } from "./request.ts";
import { SEARCH_MESSAGE, SearchCapture, summary } from "./output.ts";
import { SearchSummary } from "./render.ts";

export default function (pi: ExtensionAPI) {
  let config: Configuration = { mode: "live", source: "default", warnings: [] };
  let capture: SearchCapture | undefined;
  let requestMode: Mode = "live";
  let progress: string | undefined;
  let generation = 0;
  const selected = () => pi.getActiveTools().includes("web_search");
  const mode = (ctx: ExtensionContext) => conversationMode(ctx.sessionManager.getBranch()) ?? config.mode;
  const clear = (ctx: ExtensionContext) => { capture = undefined; progress = undefined; if (ctx.hasUI) ctx.ui.setStatus("codex-web-search", undefined); };

  pi.registerTool({
    name: "web_search", label: "Web Search", defaultActive: false, exposure: "model-only",
    description: "OpenAI-hosted web search. Selected by name; executed natively by the provider, not as a local function.",
    parameters: Type.Object({}, { additionalProperties: false }),
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: true },
    prepareLoadout: () => ({ hiddenDeclarations: ["web_search"] }),
    async execute() { throw new Error("web_search is an OpenAI-hosted tool; it cannot be executed as a local function."); },
  });

  pi.registerCommand("web-search", {
    description: "Search mode: toggle (default) | live | cached | status | reset; applies to this conversation",
    handler: async (args, ctx) => {
      const action = args.trim() || "toggle";
      if (action !== "status") {
        const next = action === "toggle" ? mode(ctx) === "live" ? "cached" : "live" : action;
        if (next !== "reset" && !isMode(next)) { ctx.ui.notify("Usage: /web-search [toggle|live|cached|status|reset]", "warning"); return; }
        pi.appendEntry(MODE_ENTRY, { version: 1, mode: next === "reset" ? null : next });
      }
      const overridden = conversationMode(ctx.sessionManager.getBranch());
      const availability = config.warnings.length ? "disabled by invalid configuration" : !selected() ? "not selected in tool loadout"
        : supportsSearch(ctx.model) ? "available" : "unavailable for this model; restored on a supported OpenAI model";
      ctx.ui.notify(`Web search: ${mode(ctx)} (${overridden ? "conversation override" : config.source}); ${availability}. Mode changes apply to the next request.`, "info");
    },
  });

  pi.registerMessageRenderer(SEARCH_MESSAGE, (message, options, theme) => new SearchSummary(
    () => typeof message.content === "string" ? message.content : message.content.filter(p => p.type === "text").map(p => p.text).join("\n"),
    () => options.expanded, theme, options.outputPad,
  ));

  pi.on("session_start", async (_event, ctx) => {
    const revision = ++generation;
    clear(ctx);
    const loaded = await loadConfig(ctx);
    if (revision !== generation) return;
    config = loaded;
    for (const warning of config.warnings) ctx.ui.notify(warning, "warning");
  });
  const reset = (_event: unknown, ctx: ExtensionContext) => { generation++; clear(ctx); };
  pi.on("session_before_switch", reset);
  pi.on("session_before_fork", reset);
  pi.on("session_before_tree", reset);
  pi.on("session_tree", reset);
  pi.on("session_shutdown", reset);
  pi.on("model_select", reset);
  pi.on("agent_end", (_event, ctx) => clear(ctx));
  pi.on("before_provider_request", (event, ctx) => {
    // Never touch another provider's payload or perform our own credential lookup.
    if (!selected() || config.warnings.length || !supportsSearch(ctx.model)) return;
    const payload = event.payload as { model?: unknown } | null;
    if (!payload || payload.model !== ctx.model?.id) return;
    const next = searchRequest(event.payload, mode(ctx));
    if (!next) return;
    clear(ctx);
    capture = new SearchCapture();
    requestMode = mode(ctx);
    return next;
  });
  pi.on("provider_stream_event", (event, ctx) => {
    if (!capture || event.provider !== ctx.model?.provider || event.api !== ctx.model.api || event.model !== ctx.model.id) return;
    capture.ingest(event.data);
    if (ctx.hasUI && capture.sawSearch) {
      const active = [...capture.calls.values()].some(status => status !== "completed" && status !== "failed");
      const next = active ? `Web search (${requestMode})…` : `Web search (${requestMode}) complete`;
      if (next !== progress) { progress = next; ctx.ui.setStatus("codex-web-search", next); }
    }
  });
  pi.on("message_end", event => {
    if (!capture?.sawSearch || event.message.role !== "assistant") return;
    const content = event.message.content.map(block => block.type === "text" ? { ...block, text: capture!.linkText(block.text, block.textSignature) } : block);
    return { message: { ...event.message, content } };
  });
  pi.on("turn_end", (event, ctx) => {
    const completed = capture;
    clear(ctx);
    if (!completed?.sawSearch) return;
    const details = completed.details(requestMode, event.outcome);
    return { entries: [{ type: "custom_message" as const, customType: SEARCH_MESSAGE, content: summary(details), details, display: true }] };
  });
}
