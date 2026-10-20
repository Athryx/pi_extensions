import type { ExtensionAPI, ExtensionContext, KeybindingsManager } from "@earendil-works/pi-coding-agent";
import { isKeyRelease, isKeyRepeat, type Component, type EditorComponent, type TUI } from "@earendil-works/pi-tui";
import { CompactView } from "./compact.js";
import { ViewedSessionController } from "./viewed-session";
import { VIEWED_SESSION_REQUEST, VIEWED_SESSION_CHANGED } from "../shared/viewed-session";
import type { ViewedSessionAPI, ViewedSessionInfo, ViewedSessionRequest } from "../shared/viewed-session";
import { PROVIDER_TOOLS_CHANGED } from "../shared/provider-tools";

const VIEW_ENTRY = "ui-view";
const WIDGET = "ui-adapter";
type ViewMode = "compact" | "compact-code" | "collapsed" | "expanded";
type FocusTUI = TUI & { getFocusedComponent?(): Component | null };
type MainEditor = EditorComponent & {
  actionHandlers?: Map<string, unknown>;
  keybindings?: KeybindingsManager;
};

/** Save only main-editor clear actions; leave dialogs, copy, and exit untouched. */
export function rememberClearedDraft(tui: FocusTUI, data: string, editorText: string): void {
  if (isKeyRelease(data) || isKeyRepeat(data)) return;
  const editor = tui.getFocusedComponent?.() as MainEditor | null | undefined;
  if (!editor?.actionHandlers?.has("app.clear") || !editor.keybindings?.matches(data, "app.clear")) return;
  if (typeof editor.getText !== "function" || editor.getText() !== editorText) return;
  const text = editor.getExpandedText?.() ?? editorText;
  if (text.trim()) editor.addToHistory?.(text);
}

export function matchesToolCycle(tui: FocusTUI, data: string): boolean {
  if (isKeyRelease(data)) return false;
  const editor = tui.getFocusedComponent?.() as MainEditor | null | undefined;
  const bindings = editor?.keybindings;
  // Only intercept the main editor's existing tool action. Dialogs, overlays,
  // and explicit history shortcuts retain their own input behavior.
  return !!editor?.actionHandlers?.has("app.tools.expand") && !!bindings
    && bindings.matches(data, "app.tools.expand")
    && !bindings.matches(data, "tui.editor.historyPrevious")
    && !bindings.matches(data, "tui.editor.historyNext");
}

export default function ui(pi: ExtensionAPI) {
  let view: CompactView | undefined;
  let transcript: ViewedSessionController | undefined;
  let cleaning = false;
  let unsubscribe: (() => void) | undefined;
  let redrawProviderTools: (() => void) | undefined;
  pi.events.on(PROVIDER_TOOLS_CHANGED, () => redrawProviderTools?.());
  const viewListeners = new Set<(view: ViewedSessionInfo | undefined) => void>();
  const api: ViewedSessionAPI = {
    version: 1,
    get available() { return transcript?.available ?? false; },
    setViewedSession: source => transcript?.setViewedSession(source) ?? false,
    getViewedSession: () => transcript?.info,
    onChange: listener => { viewListeners.add(listener); return () => { viewListeners.delete(listener); }; },
  };
  pi.events.on(VIEWED_SESSION_REQUEST, data => {
    const request = data as Partial<ViewedSessionRequest> | undefined;
    if (typeof request?.reply === "function") request.reply(api);
  });
  let compact = true;
  let currentMode: ViewMode = "compact";
  const nestedCalls: CompactView["nestedCalls"] = new Map();
  pi.on("tool_execution_start", event => {
    if (event.parentToolCallId) nestedCalls.set(event.toolCallId, { name: event.toolName, args: event.args, running: true });
  });
  pi.on("tool_execution_end", event => {
    const call = nestedCalls.get(event.toolCallId);
    if (call) { call.running = false; call.result = { ...event.result, isError: event.isError }; }
  });

  const cleanup = () => {
    cleaning = true;
    redrawProviderTools = undefined;
    unsubscribe?.(); unsubscribe = undefined;
    transcript?.dispose(); transcript = undefined;
    view?.dispose(); view = undefined;
    cleaning = false;
  };
  const setView = (mode: ViewMode, ctx: ExtensionContext) => {
    if (ctx.mode !== "tui") return;
    currentMode = mode;
    compact = mode === "compact" || mode === "compact-code";
    // The native expansion flag is irrelevant while compact; keeping it intact
    // also avoids a misleading "collapsed" notice when entering compact mode.
    if (!compact) ctx.ui.setToolsExpanded(mode === "expanded");
    transcript?.setExpanded(ctx.ui.getToolsExpanded());
    transcript?.setToolMode(mode);
    if (view) {
      view.enabled = compact;
      view.showCode = mode === "compact-code";
      view.refresh();
    }
    pi.appendEntry(VIEW_ENTRY, { mode });
    // Info notifications use Pi's conversation status line, coalescing with
    // the native two-state notice emitted by setToolsExpanded above.
    ctx.ui.notify(`Tool output: ${mode}`, "info");
  };
  const normalMode = (ctx: ExtensionContext): ViewMode => ctx.ui.getToolsExpanded() ? "expanded" : "collapsed";
  const toggle = (ctx: ExtensionContext) => {
    if (ctx.mode === "tui") setView(compact ? normalMode(ctx) : "compact", ctx);
  };
  const cycle = (ctx: ExtensionContext) => {
    if (ctx.mode === "tui") setView(currentMode === "compact" ? "compact-code" : currentMode === "compact-code" ? "collapsed" : currentMode === "collapsed" ? "expanded" : "compact", ctx);
  };

  pi.on("session_start", (_event, ctx) => {
    cleanup();
    nestedCalls.clear();
    if (ctx.mode !== "tui") return;
    let mode: ViewMode = "compact";
    for (const entry of ctx.sessionManager.getBranch()) {
      if (entry.type !== "custom" || entry.customType !== VIEW_ENTRY) continue;
      const data = entry.data as { mode?: unknown; compact?: unknown } | undefined;
      if (data?.mode === "compact" || data?.mode === "compact-code" || data?.mode === "collapsed" || data?.mode === "expanded") {
        mode = data.mode;
      } else if (typeof data?.compact === "boolean") {
        // Read preferences written by the first version of this extension.
        mode = data.compact ? "compact" : normalMode(ctx);
      }
    }
    currentMode = mode;
    compact = mode === "compact" || mode === "compact-code";
    if (!compact) {
      ctx.ui.setToolsExpanded(mode === "expanded");
      ctx.ui.notify(`Tool output: ${mode}`, "info");
    }
    // Clear the footer status left by earlier versions of this extension.
    ctx.ui.setStatus("ui", undefined);
    // A zero-height widget supplies the live TUI without replacing the user's
    // editor, header, footer, or other extensions' widgets.
    ctx.ui.setWidget(WIDGET, tui => {
      redrawProviderTools = () => tui.requestRender();
      const attachCompact = () => {
        // Release wrappers on the retired transcript, including hidden main
        // rows. Reattach only the visible tree, so switching cannot leak rows.
        view?.dispose();
        view = new CompactView(tui, () => ctx.ui.theme, compact);
        view.showCode = currentMode === "compact-code";
        view.nestedCalls = transcript?.nestedCalls ?? nestedCalls;
      };
      transcript = new ViewedSessionController(tui, ctx, info => {
        if (!cleaning) attachCompact();
        pi.events.emit(VIEWED_SESSION_CHANGED, info);
        for (const listener of viewListeners) {
          try { listener(info); } catch (error) { console.error("Viewed-session listener failed:", error); }
        }
      });
      transcript.setExpanded(ctx.ui.getToolsExpanded());
      transcript.setToolMode(currentMode);
      attachCompact();
      unsubscribe = ctx.ui.onTerminalInput(data => {
        // Raw listeners run BEFORE Pi filters Kitty key-up reports. Never turn
        // a release into a second clear/cycle action; leave it to native input.
        if (isKeyRelease(data)) return undefined;
        const handled = transcript?.handleInput(data);
        if (handled) return handled;
        if (matchesToolCycle(tui, data)) {
          if (!isKeyRepeat(data)) cycle(ctx);
          // Consume repeats too: allowing them through would invoke Pi's native
          // two-state toggle while the extension retains its four-state view.
          return { consume: true };
        }
        rememberClearedDraft(tui, data, ctx.ui.getEditorText());
        return undefined; // Native clear/double-Ctrl+C exit still runs.
      });
      return { render: () => [], invalidate() {}, dispose: cleanup };
    }, { placement: "belowEditor" });
  });

  pi.registerShortcut("ctrl+alt+o", {
    description: "Toggle very compact tool view",
    handler: async ctx => toggle(ctx),
  });
  pi.registerCommand("ui", {
    description: "Tool view: /ui compact, compact-code, collapsed, expanded, normal, toggle, or cycle",
    handler: async (args, ctx) => {
      if (ctx.mode !== "tui") return;
      const action = args.trim().toLowerCase() || "toggle";
      if (action === "toggle") toggle(ctx);
      else if (action === "cycle") cycle(ctx);
      else if (action === "normal") setView(normalMode(ctx), ctx);
      else if (action === "compact" || action === "compact-code" || action === "collapsed" || action === "expanded") setView(action, ctx);
      else ctx.ui.notify("Usage: /ui [compact|compact-code|collapsed|expanded|normal|toggle|cycle]", "warning");
    },
  });
  pi.on("session_tree", () => { transcript?.setViewedSession(undefined); });
  pi.on("session_shutdown", cleanup);
}
