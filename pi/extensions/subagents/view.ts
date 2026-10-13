import { Key, matchesKey, ScrollView, truncateToWidth, type Component, type TUI, type TuiMouseEvent, type TuiMouseEventResult } from "@earendil-works/pi-tui";
import type { Theme } from "@earendil-works/pi-coding-agent";
import type { Workspace } from "./workspace";
import { transcript, safe } from "./transcript";
import { GroupViewSelection, rootGroupId, workspaceGroups } from "./group-selection";
import { groupOverview } from "./group-view";
export class AgentsView implements Component {
  selected = "main";
  showIdle = false;
  private expanded = false;
  private height = 1;
  private panes = new Map<string, {scroll: ScrollView; follow: boolean; component?: Component; content?: string; session?: unknown}>();
  private unsubscribe: () => void;
  private unsubscribeGroup: () => void;
  private disposed = false;
  constructor(private workspace: Workspace, private tui: TUI, private theme: Theme, private done: () => void, private groups = new GroupViewSelection(), selected?: string) {
    this.groups.bind(workspace);
    const preferred = this.groups.preferred(workspace);
    this.selected = this.groups.members(workspace).find(r => r.identity.name === selected)?.identity.name ?? preferred?.identity.name ?? "";
    this.unsubscribe = workspace.subscribe(() => { this.refreshContent(); tui.requestRender(); });
    this.unsubscribeGroup = groups.subscribe(() => { this.selected = this.groups.preferred(workspace)?.identity.name ?? ""; this.invalidate(); tui.requestRender(); });
  }
  dispose(): void { if (this.disposed) return; this.disposed = true; this.unsubscribe(); this.unsubscribeGroup(); this.panes.clear(); }
  private names(): string[] {
    const id = this.groups.id(this.workspace), root = workspaceGroups(this.workspace).find(g => g.id === id)?.rootAgentInstanceId;
    return this.groups.members(this.workspace).filter(r => r.identity.instanceId === root || r.identity.name === this.selected || this.showIdle || ["starting", "running", "waiting"].includes(r.status)).map(r => r.identity.name);
  }
  private contentKey(name: string): string {
    const record = this.workspace.records.get(name);
    return JSON.stringify([record?.messages, [...record?.toolUpdates ?? []], record?.error,
      record?.session?.settingsManager?.getHideThinkingBlock() ?? record?.settings?.getHideThinkingBlock(),
      record?.session?.settingsManager?.getShowImages() ?? record?.settings?.getShowImages(),
      record?.session?.settingsManager?.getImageWidthCells() ?? record?.settings?.getImageWidthCells()]);
  }
  /** Keep completed transcript components when another agent/status/progress changes. */
  private refreshContent(): void {
    const names = new Set(this.groups.members(this.workspace).map(r => r.identity.name));
    for (const [name, pane] of this.panes) {
      if (!names.has(name)) { this.panes.delete(name); continue; }
      const key = this.contentKey(name), session = this.workspace.records.get(name)?.session;
      if (pane.content !== key || pane.session !== session) {
        pane.content = key; pane.session = session; pane.component = undefined; pane.scroll.invalidate();
      }
    }
  }
  private pane() {
    let pane = this.panes.get(this.selected);
    if (!pane) {
      const name = this.selected;
      pane = {follow: true, content: this.contentKey(name), session: this.workspace.records.get(name)?.session, scroll: new ScrollView({render: width => {
        const current = this.panes.get(name)!;
        current.component ??= transcript(this.workspace.records.get(name)!, this.tui, this.expanded);
        return current.component.render(width);
      }, invalidate() {}}, {overscroll: "contain", scrollbar: "hidden"})};
      // Bound retained transcript/layout components while browsing large groups.
      if (this.panes.size >= 32) this.panes.delete(this.panes.keys().next().value!);
      this.panes.set(this.selected, pane);
    }
    return pane;
  }
  render(width: number): string[] {
    if (this.disposed || this.workspace.closed || width < 1) return [];
    const members = this.groups.members(this.workspace);
    if (!members.some(r => r.identity.name === this.selected)) this.selected = this.groups.preferred(this.workspace)?.identity.name ?? "";
    const names = this.names(), record = members.find(r => r.identity.name === this.selected);
    const idle = members.filter(r => r.identity.parentName !== null && r.identity.name !== "main" && !["starting", "running", "waiting"].includes(r.status)).length;
    const fit = (text: string) => truncateToWidth(text, width, "…", true);
    this.height = Math.max(1, this.tui.terminal.rows - 3);
    if (!record) return groupOverview(this.workspace, this.groups.id(this.workspace)).split("\n").map(fit).slice(0, this.height).concat(fit("Esc main"));
    const pane = this.pane();
    const lines = pane.scroll.render(Math.max(1, width));
    pane.scroll.updateLayout(lines.length, this.height, () => this.tui.requestRender());
    if (pane.follow) pane.scroll.scrollToEnd();
    return [
      fit(names.map(n => this.theme.fg(n === this.selected ? "accent" : "muted", safe(n === this.selected ? "[" + n + "]" : n))).join(" · ")),
      fit(this.theme.fg("muted", safe(record.identity.name + " · " + record.status + " · parent: " + (members.some(r => r.identity.name === record.identity.parentName) ? record.identity.parentName : "none") + " · " + (record.selection?.model.id ?? "") + " · Idle (" + idle + ")" + (this.showIdle ? " shown" : " hidden")))),
      ...Array.from({length: this.height}, (_, i) => fit(lines[pane.scroll.scrollTop + i] ?? "")),
      fit(this.theme.fg("dim", "Tab/←→ agent · ↑↓/PgUp/PgDn scroll · End follow · i idle · o tools · Esc main")),
    ];
  }
  handleInput(data: string): void {
    if (matchesKey(data, Key.escape) || matchesKey(data, "q")) { this.dispose(); this.groups.set(this.workspace, rootGroupId(this.workspace)); this.done(); return; }
    if (!this.groups.members(this.workspace).length) return;
    if (matchesKey(data, "i")) this.showIdle = !this.showIdle;
    else if (matchesKey(data, "o")) { this.expanded = !this.expanded; this.invalidate(); }
    else if (matchesKey(data, Key.tab) || matchesKey(data, Key.right) || matchesKey(data, Key.shift("tab")) || matchesKey(data, Key.left)) {
      const names = this.names(), backwards = matchesKey(data, Key.left) || matchesKey(data, Key.shift("tab"));
      if (names.length) {
        this.selected = names[(names.indexOf(this.selected) + (backwards ? names.length - 1 : 1)) % names.length];
        const record = this.workspace.records.get(this.selected);
        if (record) this.groups.remember(this.workspace, record);
      }
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
    if (event.type !== "wheel" || !this.groups.members(this.workspace).some(r => r.identity.name === this.selected)) return undefined;
    const pane = this.pane(); pane.follow = false; pane.scroll.scrollBy(event.wheelDelta ?? 0); this.tui.requestRender();
    return {handled: true};
  }
  invalidate(): void {
    const names = new Set(this.groups.members(this.workspace).map(r => r.identity.name));
    for (const [name, pane] of this.panes) {
      if (!names.has(name)) this.panes.delete(name);
      else { pane.component = undefined; pane.scroll.invalidate(); }
    }
  }
}
