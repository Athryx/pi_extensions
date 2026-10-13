import { Key, matchesKey, Text, type Component, type TUI } from "@earendil-works/pi-tui";
import type { Theme } from "@earendil-works/pi-coding-agent";
import type { ViewedSessionSource } from "../shared/viewed-session";
import type { Workspace } from "./workspace";
import { groupMembers, workspaceGroups } from "./group-selection";
import { safe } from "./transcript";

export function groupOverview(workspace: Workspace, id: string): string {
  const groups = workspaceGroups(workspace), group = groups.find(g => g.id === id);
  if (!group) return "Agent group is no longer available.";
  const members = groupMembers(workspace, id);
  const rows = [`${safe(group.label).replace(/[\n\r\t]/g, " ")} [${id}]`, "Read-only group overview · " + (members.length ? `${members.length} agents (select this group again to view)` : "No agents"), ...(group.status ? ["Status: " + group.status] : []), ...(group.error ? ["Error: " + safe(group.error)] : [])];
  for (const child of groups.filter(g => g.parentGroupId === id)) {
    const members = groupMembers(workspace, child.id);
    rows.push(`  ${safe(child.label)} [${child.id}] · ${members.length} agents · ${child.status ?? members[0]?.status ?? "empty"}`);
  }
  rows.push("Use /groups <id> to inspect a child group; Escape returns to main (exit overlays first).");
  return rows.join("\n");
}

/** An overview source, not a dummy agent/session. Its messages never enter model context. */
export function groupOverviewSource(workspace: Workspace, id: string): ViewedSessionSource {
  let cached: {content: string; messages: ReturnType<ViewedSessionSource["getSnapshot"]>["messages"]} | undefined;
  return {
    id: "subagents:group:" + id,
    kind: "group",
    title: safe(workspaceGroups(workspace).find(g => g.id === id)?.label ?? id),
    getSnapshot() {
      const content = groupOverview(workspace, id);
      if (cached?.content !== content) cached = {content, messages: [{role: "custom", customType: "subagents.group-overview.v1", content, display: true, timestamp: 0}]};
      return {messages: cached!.messages};
    },
    subscribe: listener => workspace.subscribe(listener),
  };
}

/** Safe fallback for empty/queued/failed groups when native viewing is unavailable. */
export class GroupView implements Component {
  private unsubscribe: () => void;
  private cache?: {key: string; lines: string[]};
  private disposed = false;
  constructor(private workspace: Workspace, private id: string, private tui: TUI, private theme: Theme, private done: () => void) {
    this.unsubscribe = workspace.subscribe(() => tui.requestRender());
  }
  render(width: number): string[] {
    if (this.disposed || width < 1 || this.workspace.closed) return [];
    const content = groupOverview(this.workspace, this.id) + "\nEsc main";
    const height = Math.max(1, this.tui.terminal.rows);
    const key = JSON.stringify([width, height, content, this.theme.fg("muted", "")]);
    if (this.cache?.key === key) return this.cache.lines;
    const lines = new Text(this.theme.fg("muted", content), 0, 0).render(width).slice(0, height);
    // An empty-group overlay must cover main, not display its unrelated history.
    while (lines.length < height) lines.push("");
    this.cache = {key, lines}; return lines;
  }
  handleInput(data: string): void { if (matchesKey(data, Key.escape) || matchesKey(data, "q")) { this.dispose(); this.done(); } }
  invalidate(): void { this.cache = undefined; }
  dispose(): void { if (this.disposed) return; this.disposed = true; this.cache = undefined; this.unsubscribe(); }
}
