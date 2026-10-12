import type { ExtensionAPI, ExtensionContext, ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { TSchema } from "typebox";
import { isWorkerSession } from "./agent-role";

/** Interactive means a user-facing TUI, never a background worker (even in a TUI viewer). */
export function isInteractive(ctx: Pick<ExtensionContext, "mode" | "sessionManager">): boolean {
  return ctx.mode === "tui" && (!ctx.sessionManager || !isWorkerSession(ctx.sessionManager));
}

/** Extension-owned marker; Pi itself does not interpret this extra definition field. */
export function interactiveTool<T extends TSchema, D = unknown, S = any>(tool: ToolDefinition<T, D, S>): ToolDefinition<T, D, S> & { interactiveOnly: true } {
  return {...tool, interactiveOnly: true, async execute(id, args, signal, update, ctx) {
    if (!isInteractive(ctx)) throw new Error("Tool is only available to the interactive agent: " + tool.name);
    return tool.execute(id, args, signal, update, ctx);
  }};
}
export function isInteractiveTool(tool: object): boolean {
  return (tool as {interactiveOnly?: boolean}).interactiveOnly === true;
}

/** Register from session_start so headless sessions never receive tool usage guidance. */
export function registerInteractiveTool<T extends TSchema, D = unknown, S = any>(pi: ExtensionAPI, tool: ToolDefinition<T, D, S>, ctx: ExtensionContext): void {
  const marked = interactiveTool(tool);
  pi.registerTool(isInteractive(ctx) ? marked : {
    ...marked, exposure: "hidden", defaultActive: false, promptSnippet: undefined, promptGuidelines: undefined,
  });
}

/** Mark a whole structured usage-guidance snippet as interactive-only. */
export function interactiveSection(sections: Record<string, string>, key: string, text: string, ctx: ExtensionContext): void {
  if (isInteractive(ctx)) sections[key] = text;
  else delete sections[key];
}
