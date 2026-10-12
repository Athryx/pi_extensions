import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { toToolDeclaration } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { buildSnapshot } from "./model";
import { ContextView } from "./view";

export default function contextExtension(pi: ExtensionAPI): void {
  let lastRequest: { messages: AgentMessage[]; model: string; time: string } | undefined;
  const clear = () => { lastRequest = undefined; };
  pi.on("session_start", clear);
  pi.on("session_switch", clear);
  pi.on("session_fork", clear);
  pi.on("session_tree", clear);
  pi.on("session_compact", clear);
  pi.on("session_shutdown", clear);

  // Observe only: never return replacement messages, persist data, or make model calls.
  pi.on("context_with_system", (event, ctx) => {
    if (ctx.mode !== "tui") return;
    // UI-only tool details can contain non-cloneable values and are not sent to the model.
    const messages = event.messages.map(message => {
      if (message.role !== "toolResult") return message;
      const { details, ...rest } = message;
      return rest;
    });
    lastRequest = {
      messages: structuredClone(messages),
      model: ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : "No model selected",
      time: new Date().toLocaleTimeString(),
    };
  });

  pi.registerCommand("context", {
    description: "Browse system prompt, tool schemas, messages, and estimated context tokens",
    handler: async (_args, ctx) => {
      if (ctx.mode !== "tui") {
        ctx.ui.notify("/context requires interactive TUI mode.", "error");
        return;
      }
      const hidden = new Set(ctx.getSystemPromptOptions().hiddenTools ?? []);
      const active = new Set(pi.getActiveTools());
      const snapshots = [buildSnapshot({
        messages: ctx.sessionManager.buildSessionProjection().messages,
        current: {
          prompt: ctx.getSystemPrompt(),
          tools: pi.getAllTools().filter(tool => active.has(tool.name) && !hidden.has(tool.name)).map(toToolDeclaration),
        },
        source: "Current effective context",
        model: ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : "No model selected",
        usage: ctx.getContextUsage(),
      })];
      if (lastRequest) snapshots.push(buildSnapshot({
        messages: lastRequest.messages,
        source: `Last captured request (${lastRequest.time})`,
        model: lastRequest.model,
        usage: ctx.getContextUsage(),
      }));
      await ctx.ui.custom<void>(
        (tui, theme, keybindings, done) => new ContextView(snapshots, tui, theme, keybindings, () => done()),
        { overlay: true, overlayOptions: { width: "100%", maxHeight: "100%", anchor: "center" } },
      );
    },
  });
}
