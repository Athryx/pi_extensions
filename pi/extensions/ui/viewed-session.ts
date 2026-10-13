import type { ExtensionContext, KeybindingsManager } from "@earendil-works/pi-coding-agent";
import { Container, Text, Spacer, isKeyRelease, isKeyRepeat, type Component, type EditorComponent, type ScrollView, type TUI } from "@earendil-works/pi-tui";
import type { ViewedSessionInfo, ViewedSessionSource } from "../shared/viewed-session";
import { ViewedTranscript, plainLabel } from "./transcript";
import { sameKey, themeKey } from "./render-cache.js";

type Branch = Component & {children: Component[]};
type MainEditor = EditorComponent & {keybindings?: KeybindingsManager; actionHandlers?: Map<string, unknown>};
type NativeTUI = TUI & {
  getFocusedComponent?(): Component | null;
  getPrimaryScrollView?(): ScrollView;
  resetTextSelection?(): void;
  getActiveSelectionText?(): string | undefined;
};
type Binding = {document: Branch; main: Branch; editor: Branch; input: MainEditor};
type Position = {top: number; follow: boolean};
const branch = (component: Component | undefined): component is Branch => Array.isArray((component as Partial<Branch> | undefined)?.children);

/** Only this adapter knows Pi's private document/input-dock layout (Pi 1.1). */
function nativeBinding(tui: TUI): Binding | undefined {
  const roots = tui.children;
  if (roots.length !== 7 || !roots.every(branch)) return;
  const document = roots[0] as Branch;
  if (document.children.length !== 3 || !document.children.every(branch)) return;
  const editor = roots[4] as Branch;
  const input = editor.children[0] as MainEditor | undefined;
  if (editor.children.length !== 1 || typeof input?.getText !== "function" || !input.keybindings || !(input.actionHandlers instanceof Map)) return;
  return {document, main: document.children[2] as Branch, editor, input};
}

/** Display-only controller. Never binds/disposes sessions or mutates main's chat. */
export class ViewedSessionController {
  private binding?: Binding;
  private source?: ViewedSessionSource;
  private unsubscribe?: () => void;
  private pane?: ViewedTranscript;
  private visible?: Container;
  private disposed = false;
  private cancelPositionRestore?: () => void;
  private expanded = false;
  private toolMode = "compact";
  private notice?: string;
  private exitKey?: {bindings: KeybindingsManager; action: "app.interrupt" | "app.clear"};
  private positions = new Map<string, Position>();
  constructor(private tui: NativeTUI, private ctx: ExtensionContext, private onChanged: (view: ViewedSessionInfo | undefined) => void) {}

  get available(): boolean {
    if (this.disposed) return false;
    if (this.binding) return this.tui.children[0] === this.binding.document && this.tui.children[4] === this.binding.editor && this.binding.document.children[2] === this.visible;
    return !!nativeBinding(this.tui);
  }
  get info(): ViewedSessionInfo | undefined { return this.source ? {id: this.source.id, title: this.source.title} : undefined; }
  get nestedCalls(): ViewedTranscript["nestedCalls"] | undefined { return this.pane?.nestedCalls; }

  setViewedSession(source: ViewedSessionSource | undefined): boolean {
    if (this.disposed) return false;
    if (!source) { this.restore(); return true; }
    if (typeof source.id !== "string" || !source.id || typeof source.title !== "string" || typeof source.getSnapshot !== "function" || typeof source.subscribe !== "function") throw new Error("Invalid viewed-session source");
    if (!this.available) return false;
    const binding = this.binding ?? nativeBinding(this.tui)!;
    if (this.source === source) { this.refresh(); return true; }
    // Preflight before hiding main, and subscribe before reading the live snapshot.
    const pane = new ViewedTranscript(this.tui);
    let installing = true;
    let unsubscribe: (() => void) | undefined;
    try {
      unsubscribe = source.subscribe(() => { if (!installing && this.source === source) this.refresh(); });
      if (typeof unsubscribe !== "function") throw new Error("Viewed-session subscription must return an unsubscribe function");
      pane.sync(source.getSnapshot()); pane.setExpanded(this.expanded);
    } catch (error) { if (typeof unsubscribe === "function") unsubscribe(); throw error; }
    this.savePosition(); this.stopSubscription();
    this.binding = binding; this.source = source; this.pane = pane; this.unsubscribe = unsubscribe;
    this.notice = undefined;
    this.visible = new Container();
    const title = new Text("", 1, 0), notice = new Text("", 1, 0);
    let contentKey: unknown[] | undefined, renderKey: unknown[] | undefined;
    let bannerLines: string[] = [];
    this.visible.addChild({render: width => {
      const theme = this.ctx.ui.theme;
      const content = [...themeKey(theme), source.title, source.kind, this.toolMode, this.notice];
      const key = [width, ...content];
      if (sameKey(renderKey, key)) return bannerLines;
      if (!sameKey(contentKey, content)) {
        title.setText(theme.fg("accent", `${source.kind === "group" ? "Group" : "Agent"}: ${plainLabel(source.title)}`)
          + theme.fg("muted", ` · read-only · tools: ${this.toolMode} · Esc returns to main · footer/runtime: main`));
        notice.setText(this.notice ? theme.fg("warning", this.notice) : "");
        contentKey = content;
      }
      bannerLines = [...title.render(width), ...(this.notice ? notice.render(width) : [])];
      renderKey = key;
      return bannerLines;
    }, invalidate() { renderKey = undefined; title.invalidate(); notice.invalidate(); }});
    this.visible.addChild(new Spacer(1)); this.visible.addChild(pane);
    binding.document.children[2] = this.visible;
    installing = false;
    this.ctx.ui.setStatus("ui-viewed-session", `Viewing ${plainLabel(source.title)} (read-only; main runtime)`);
    this.changed(); this.restorePosition(source.id); this.onChanged(this.info);
    return true;
  }

  refresh(): void {
    if (!this.source || this.disposed) return;
    try {
      this.pane!.sync(this.source.getSnapshot());
      // sync updates/invalidate only changed native rows. A global invalidate
      // here would discard all finished-row caches on every worker delta.
      this.tui.requestRender();
    } catch (error) {
      this.restore();
      this.ctx.ui.notify(`Cannot display agent transcript: ${error instanceof Error ? error.message : String(error)}`, "warning");
    }
  }
  setExpanded(value: boolean): void { this.expanded = value; this.pane?.setExpanded(value); }
  setToolMode(mode: string): void { this.toolMode = mode; this.notice = undefined; if (this.source) this.changed(); }
  private warn(message: string): void { this.notice = message; this.changed(); }

  /** Runs before the editor. Dialogs/overlays retain their own input ownership. */
  handleInput(data: string): {consume: true} | undefined {
    if (isKeyRelease(data) || this.disposed) return;
    if (!this.source) {
      // A held Kitty Escape/Ctrl+C must not exit the view on its first report
      // and then abort/clear main on repeat reports from that same key press.
      if (isKeyRepeat(data) && this.exitKey?.bindings.matches(data, this.exitKey.action)) return {consume: true};
      if (!isKeyRepeat(data)) this.exitKey = undefined;
      return;
    }
    const editor = this.binding?.input;
    // Pi's extension dialogs replace the editor dock's child, not just focus.
    // Only intercept the original main editor; selectors retain every key.
    if (!editor || this.binding?.editor.children[0] !== editor || this.tui.getFocusedComponent?.() !== editor) return;
    const bindings = editor.keybindings;
    if (!bindings) { this.restore(); return {consume: true}; }
    const selectedText = this.tui.getActiveSelectionText?.();
    if (bindings.matches(data, "app.interrupt") || (bindings.matches(data, "app.clear") && !selectedText)) {
      if (!isKeyRepeat(data)) {
        this.exitKey = {bindings, action: bindings.matches(data, "app.interrupt") ? "app.interrupt" : "app.clear"};
        this.restore();
      }
      return {consume: true};
    }
    // Respect explicit editor history bindings, like Pi's CustomEditor does.
    if (bindings.matches(data, "tui.editor.historyPrevious") || bindings.matches(data, "tui.editor.historyNext")) return;
    if (bindings.matches(data, "app.thinking.toggle")) {
      if (!isKeyRepeat(data)) { this.pane?.toggleThinking(); this.changed(); }
      return {consume: true};
    }
    const submit = bindings.matches(data, "tui.input.submit") || bindings.matches(data, "app.message.followUp");
    if (submit) {
      const text = (editor.getExpandedText?.() ?? editor.getText()).trim();
      // These commands operate the display only. Never pass a worker-looking
      // prompt, shell command, /skill, or session mutation to main by accident.
      if (bindings.matches(data, "tui.input.submit") && /^\/(?:groups|subagents|ui)(?:[ \t][^\r\n]*)?$/.test(text)) return;
      if (!isKeyRepeat(data)) this.warn("Agent view is read-only. Press Escape to return to main before submitting.");
      return {consume: true};
    }
    const mainOnly = ["app.model.cycleForward", "app.model.cycleBackward", "app.model.select", "app.thinking.cycle", "app.thinking.save", "app.session.new", "app.session.tree", "app.session.fork", "app.session.resume", "app.message.dequeue"] as const;
    if (mainOnly.some(action => bindings.matches(data, action)) || (bindings.matches(data, "app.message.copy") && !selectedText)) {
      if (!isKeyRepeat(data)) this.warn("This control belongs to main. Press Escape to return first.");
      return {consume: true};
    }
  }

  private changed(): void { this.tui.invalidate(); this.tui.requestRender(); }
  private stopSubscription(): void {
    const unsubscribe = this.unsubscribe; this.unsubscribe = undefined;
    try { unsubscribe?.(); } catch (error) { console.error("Viewed-session cleanup failed:", error); }
  }
  private savePosition(): void {
    const scroll = this.tui.getPrimaryScrollView?.();
    if (scroll) this.positions.set(this.source?.id ?? "", {top: scroll.scrollTop, follow: scroll.isFollowingEnd});
  }
  private restorePosition(id: string): void {
    this.tui.resetTextSelection?.();
    this.cancelPositionRestore?.();
    const position = this.positions.get(id);
    const scroll = this.tui.getPrimaryScrollView?.();
    if (!scroll) return;
    if (!position || position.follow) { scroll.scrollToEnd(); return; }
    // Restore only after the next native layout knows the new document height.
    // A timer/microtask could run before Pi's throttled render and clamp against
    // the old transcript. This one-frame instance adapter is removed immediately.
    const original = scroll.updateLayout;
    const own = Object.hasOwn(scroll, "updateLayout");
    const cancel = () => {
      if (scroll.updateLayout === wrapped) {
        if (own) scroll.updateLayout = original;
        else delete (scroll as Partial<ScrollView>).updateLayout;
      }
      if (this.cancelPositionRestore === cancel) this.cancelPositionRestore = undefined;
    };
    const wrapped: ScrollView["updateLayout"] = (...args) => {
      original.apply(scroll, args);
      cancel();
      if (!this.disposed) scroll.scrollTo(position.top, {disableFollow: true});
    };
    this.cancelPositionRestore = cancel;
    scroll.updateLayout = wrapped;
  }
  private restore(): void {
    if (!this.source) return;
    this.savePosition(); this.stopSubscription();
    const binding = this.binding;
    if (binding && binding.document.children[2] === this.visible) binding.document.children[2] = binding.main;
    this.source = undefined; this.visible = undefined; this.pane = undefined; this.binding = undefined;
    this.ctx.ui.setStatus("ui-viewed-session", undefined);
    this.changed(); this.restorePosition(""); this.onChanged(undefined);
  }
  dispose(): void {
    if (this.disposed) return;
    // Mark unavailable before broadcasting restoration: an onChange listener
    // must not install another source while the owning runtime is being reset.
    this.disposed = true; this.restore();
    this.cancelPositionRestore?.(); this.positions.clear();
  }
}
