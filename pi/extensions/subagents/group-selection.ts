import type { AgentGroup, AgentRecord } from "./types";
import type { Workspace } from "./workspace";
import { safe } from "./transcript";

/** Legacy fixtures/sessions without group metadata have exactly one group. */
export function rootGroupId(workspace: Workspace): string { return workspace.rootGroupId ?? "root"; }
export function groupMembers(workspace: Workspace, id: string): AgentRecord[] {
  if (typeof workspace.members === "function") return workspace.members(id);
  return [...workspace.records.values()].filter(r => (r.identity.groupId ?? rootGroupId(workspace)) === id);
}
export function workspaceGroups(workspace: Workspace): AgentGroup[] {
  return workspace.groups ? [...workspace.groups.values()] : [{version: 1, id: rootGroupId(workspace), parentGroupId: null, kind: "root", label: "Root group", rootAgentInstanceId: workspace.records.get("main")?.identity.instanceId ?? null}];
}

/** Human navigation only. Never used to bind tools or choose a prompt target. */
export class GroupViewSelection {
  private workspace?: Workspace;
  private current?: string;
  private remembered = new Map<string, string>();
  private listeners = new Set<() => void>();
  private menuCache?: {key: string; rows: {id: string; label: string}[]};
  private generation = 0;

  bind(workspace: Workspace): void {
    if (this.workspace === workspace) return;
    this.workspace = workspace; this.current = rootGroupId(workspace);
    this.remembered.clear(); this.menuCache = undefined; this.generation++; this.changed();
  }
  clear(): void {
    this.workspace = undefined; this.current = undefined;
    this.remembered.clear(); this.menuCache = undefined; this.generation++; this.changed();
  }
  id(workspace: Workspace): string {
    this.bind(workspace);
    if (!workspaceGroups(workspace).some(g => g.id === this.current)) this.set(workspace, rootGroupId(workspace));
    return this.current!;
  }
  set(workspace: Workspace, id: string): void {
    this.bind(workspace);
    if (id === "root") id = rootGroupId(workspace);
    if (!workspaceGroups(workspace).some(g => g.id === id)) throw new Error("Unknown agent group: " + id);
    if (id === this.current) return;
    this.current = id; this.generation++; this.changed();
  }
  members(workspace: Workspace): AgentRecord[] { return groupMembers(workspace, this.id(workspace)); }
  remember(workspace: Workspace, record: AgentRecord): void {
    const id = this.id(workspace);
    if (groupMembers(workspace, id).includes(record)) this.remembered.set(id, record.identity.instanceId);
  }
  preferred(workspace: Workspace): AgentRecord | undefined {
    const id = this.id(workspace), records = groupMembers(workspace, id);
    const remembered = records.find(r => r.identity.instanceId === this.remembered.get(id));
    const group = workspaceGroups(workspace).find(g => g.id === id);
    return remembered ?? records.find(r => r.identity.instanceId === group?.rootAgentInstanceId) ?? records.find(r => r.identity.parentName === null) ?? records[0];
  }
  subscribe(listener: () => void): () => void { this.listeners.add(listener); return () => this.listeners.delete(listener); }
  private changed(): void { for (const listener of this.listeners) listener(); }
  /** One cached tree/menu: status and membership mutations invalidate even in place. */
  tree(workspace: Workspace): {id: string; label: string}[] {
    const groups = workspaceGroups(workspace);
    const data = groups.map(g => ({...g, members: groupMembers(workspace, g.id).map(r => [r.identity.instanceId, r.status])}));
    const key = JSON.stringify(data);
    if (this.menuCache?.key === key) return this.menuCache.rows;
    const rows: {id: string; label: string}[] = [], seen = new Set<string>();
    const visit = (id: string, depth: number) => {
      if (seen.has(id)) return;
      seen.add(id);
      const group = groups.find(g => g.id === id);
      if (!group) return;
      const members = groupMembers(workspace, id);
      const states = [...new Set(members.map(r => r.status))].join(", ") || group.status || "empty";
      rows.push({id, label: `${"  ".repeat(Math.min(depth, 32))}${safe(group.label).replace(/[\n\r\t]/g, " ")} [${id}] · ${members.length} agents · ${states}`});
      for (const child of groups) if (child.parentGroupId === id) visit(child.id, depth + 1);
    };
    visit(rootGroupId(workspace), 0);
    this.menuCache = {key, rows}; return rows;
  }
  async choose(workspace: Workspace, args: string, select: (title: string, options: string[]) => Promise<string | undefined>): Promise<boolean> {
    this.bind(workspace);
    const generation = this.generation;
    let id = args.trim();
    if (!id) {
      const rows = this.tree(workspace);
      const choice = await select("Agent groups (read-only)", rows.map(row => row.label));
      if (!choice) return false;
      id = rows.find(row => row.label === choice)?.id ?? "";
    }
    if (!id || workspace.closed || this.workspace !== workspace || this.generation !== generation) return false;
    this.set(workspace, id); return true;
  }
}
