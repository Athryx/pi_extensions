import { Key, matchesKey, ScrollView, truncateToWidth, type Component, type TUI, type TuiMouseEvent, type TuiMouseEventResult } from "@earendil-works/pi-tui";
import type { Theme } from "@earendil-works/pi-coding-agent";
import type { Workspace } from "./workspace";
import { transcript, safe } from "./transcript";
export class AgentsView implements Component {
  selected = "main";
  showIdle = false;
  private expanded = false;
  private height = 1;
  private panes = new Map<string, {scroll: ScrollView; follow: boolean; component?: Component}>();
  private unsubscribe: () => void;
  constructor(private workspace: Workspace, private tui: TUI, private theme: Theme, private done: () => void) {
    this.unsubscribe = workspace.subscribe(() => { this.invalidate(); tui.requestRender(); });
  }
  dispose(): void { this.unsubscribe(); }
  private names(): string[] {
    return [...this.workspace.records.values()].filter(r => r.identity.name === "main" || r.identity.name === this.selected || this.showIdle || ["starting", "running", "waiting"].includes(r.status)).map(r => r.identity.name);
  }
  private pane() {
    let pane = this.panes.get(this.selected);
    if (!pane) {
      pane = {follow: true, scroll: new ScrollView({render: width => {
        const current = this.panes.get(this.selected)!;
        current.component ??= transcript(this.workspace.records.get(this.selected)!, this.tui, this.expanded);
        return current.component.render(width);
      }, invalidate() {}}, {overscroll: "contain", scrollbar: "hidden"})};
      this.panes.set(this.selected, pane);
    }
    return pane;
  }
  render(width: number): string[] {
    const names = this.names(), record = this.workspace.records.get(this.selected)!;
    const idle = [...this.workspace.records.values()].filter(r => r.identity.name !== "main" && !["starting", "running", "waiting"].includes(r.status)).length;
    const fit = (text: string) => truncateToWidth(text, width, "…", true);
    this.height = Math.max(1, this.tui.terminal.rows - 3);
    const pane = this.pane();
    const lines = pane.scroll.render(Math.max(1, width));
    pane.scroll.updateLayout(lines.length, this.height, () => this.tui.requestRender());
    if (pane.follow) pane.scroll.scrollToEnd();
    return [
      fit(names.map(n => this.theme.fg(n === this.selected ? "accent" : "muted", n === this.selected ? "[" + n + "]" : n)).join(" · ")),
      fit(this.theme.fg("muted", safe(record.identity.name + " · " + record.status + " · parent: " + (record.identity.parentName ?? "none") + " · " + (record.selection?.model.id ?? "") + " · Idle (" + idle + ")" + (this.showIdle ? " shown" : " hidden")))),
      ...Array.from({length: this.height}, (_, i) => fit(lines[pane.scroll.scrollTop + i] ?? "")),
      fit(this.theme.fg("dim", "Tab/←→ agent · ↑↓/PgUp/PgDn scroll · End follow · i idle · o tools · Esc main")),
    ];
  }
  handleInput(data: string): void {
    if (matchesKey(data, Key.escape) || matchesKey(data, "q")) { this.dispose(); this.done(); return; }
    if (matchesKey(data, "i")) this.showIdle = !this.showIdle;
    else if (matchesKey(data, "o")) { this.expanded = !this.expanded; this.invalidate(); }
    else if (matchesKey(data, Key.tab) || matchesKey(data, Key.right) || matchesKey(data, Key.shift("tab")) || matchesKey(data, Key.left)) {
      const names = this.names(), backwards = matchesKey(data, Key.left) || matchesKey(data, Key.shift("tab"));
      this.selected = names[(names.indexOf(this.selected) + (backwards ? names.length - 1 : 1)) % names.length];
    } else {
      const pane = this.pane();
      if (matchesKey(data, Key.end)) { pane.follow = true; pane.scroll.scrollToEnd(); }
      else if (matchesKey(data, Key.home)) { pane.follow = false; pane.scroll.scrollToStart(); }
      else {
        let delta = 0;
        if (matchesKey(data, Key.up)) delta = -1;
        if (matchesKey(data, Key.down)) delta = 1;
        if (matchesKey(data, Key.pageUp)) delta = -this.height;
        if (matchesKey(data, Key.pageDown)) delta = this.height;
        if (delta) { pane.follow = false; pane.scroll.scrollBy(delta); }
      }
    }
    this.tui.requestRender();
  }
  handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
    if (event.type !== "wheel") return undefined;
    const pane = this.pane(); pane.follow = false; pane.scroll.scrollBy(event.wheelDelta ?? 0); this.tui.requestRender();
    return {handled: true};
  }
  invalidate(): void {
    for (const pane of this.panes.values()) { pane.component = undefined; pane.scroll.invalidate(); }
  }
}
