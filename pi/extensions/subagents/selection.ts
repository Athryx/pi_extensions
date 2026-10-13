import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { requestViewedSessionAPI, type ViewedSessionAPI, type ViewedSessionSource } from "../shared/viewed-session";
import type { Workspace } from "./workspace";
import { GroupViewSelection, rootGroupId } from "./group-selection";
import { groupOverviewSource } from "./group-view";

/** Select a read-only UI transcript without changing the interactive session. */
export class AgentViewSelection {
  private owned?: { api: ViewedSessionAPI; id: string };
  private observed?: ViewedSessionAPI;
  private unsubscribeView?: () => void;
  private workspace?: Workspace;
  private generation = 0;
  private suppressRestore = false;

  constructor(private pi: ExtensionAPI, readonly groups = new GroupViewSelection()) {}

  private api(workspace: Workspace): ViewedSessionAPI | undefined {
    const replaced = this.workspace !== workspace;
    if (replaced) this.generation++;
    this.groups.bind(workspace); this.workspace = workspace;
    const api = requestViewedSessionAPI(this.pi);
    if (this.observed !== api || replaced) {
      this.unsubscribeView?.(); this.observed = api;
      this.unsubscribeView = api?.onChange(view => {
        if (this.workspace !== workspace || workspace.closed || this.suppressRestore) return;
        if (!view) { this.groups.set(workspace, rootGroupId(workspace)); this.owned = undefined; }
        else {
          const record = [...workspace.records.values()].find(r => r.identity.instanceId === view.id);
          if (record) { this.groups.set(workspace, record.identity.groupId ?? rootGroupId(workspace)); this.groups.remember(workspace, record); }
        }
      });
    }
    return api;
  }
  /** Validate even without native viewing so the overlay cannot navigate out of group. */
  target(workspace: Workspace, name: string): void {
    if (name === "main") { this.groups.set(workspace, rootGroupId(workspace)); return; }
    const record = workspace.get(name);
    if (!this.groups.members(workspace).includes(record)) throw new Error(`Agent ${name} is in another group; select it with /groups first.`);
  }
  /** Return false when the legacy overlay should handle the command. */
  async select(workspace: Workspace, args: string, ctx: ExtensionContext): Promise<boolean> {
    if (ctx.mode !== "tui") return false;
    if (!args.trim() && !this.groups.members(workspace).length) return this.selectGroup(workspace, ctx);
    if (args.trim()) this.target(workspace, args.trim());
    const api = this.api(workspace);
    if (!api?.available) return false;
    const group = this.groups.id(workspace), generation = this.generation;
    const name = args.trim() || await ctx.ui.select("View agent (read-only)", this.groups.members(workspace).map(r => r.identity.name));
    // Picker choices never survive workspace/group replacement or clearing.
    if (!name || workspace.closed || this.workspace !== workspace || generation !== this.generation || group !== this.groups.id(workspace)) return true;
    if (!args.trim() && !this.groups.members(workspace).some(r => r.identity.name === name)) return true;
    this.target(workspace, name);
    if (name === "main") {
      const restored = api.setViewedSession(undefined);
      if (restored) this.owned = undefined;
      return restored;
    }
    const record = workspace.get(name);
    const source: ViewedSessionSource = {
      id: record.identity.instanceId,
      title: record.identity.name,
      getSnapshot: () => ({
        messages: record.messages, session: record.session, manager: record.manager,
        settings: record.settings, toolUpdates: record.toolUpdates,
      }),
      subscribe: listener => workspace.subscribe(listener),
    };
    if (!api.setViewedSession(source)) return false;
    this.groups.remember(workspace, record);
    this.owned = {api, id: source.id}; return true;
  }
  /** Show a remembered/root member or an empty overview, never another group's main. */
  async selectGroup(workspace: Workspace, ctx: ExtensionContext): Promise<boolean> {
    const record = this.groups.preferred(workspace);
    if (record) return this.select(workspace, record.identity.name, ctx);
    const api = this.api(workspace);
    if (!api?.available) { this.clearTranscript(); return false; }
    const source = groupOverviewSource(workspace, this.groups.id(workspace));
    if (!api.setViewedSession(source)) { this.clearTranscript(); return false; }
    this.owned = {api, id: source.id}; return true;
  }
  /** Cycle only direct group members, including idle workers. */
  async cycle(workspace: Workspace, direction: 1 | -1, ctx: ExtensionContext): Promise<boolean> {
    if (ctx.mode !== "tui" || workspace.closed) return false;
    const records = this.groups.members(workspace);
    if (!records.length) return true;
    const api = this.api(workspace);
    if (!api?.available) return false;
    const viewed = api.getViewedSession()?.id;
    const index = viewed ? records.findIndex(record => record.identity.instanceId === viewed) : records.findIndex(record => record.identity.name === "main");
    const next = records[index < 0 ? (direction === 1 ? 0 : records.length - 1) : (index + direction + records.length) % records.length];
    return this.select(workspace, next.identity.name, ctx);
  }
  /** Clear an old native transcript for fallback without resetting intentional group selection. */
  clearTranscript(): void {
    const owned = this.owned; this.owned = undefined;
    this.suppressRestore = true;
    try { if (owned && owned.api.getViewedSession()?.id === owned.id) owned.api.setViewedSession(undefined); }
    finally { this.suppressRestore = false; }
  }
  /** Drop old workspace references on reload, navigation, replacement or shutdown. */
  clear(): void {
    this.generation++; this.unsubscribeView?.(); this.unsubscribeView = undefined;
    this.observed = undefined; this.workspace = undefined;
    this.clearTranscript(); this.groups.clear();
  }
}
