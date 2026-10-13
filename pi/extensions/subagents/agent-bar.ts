import type { ExtensionAPI, Theme } from "@earendil-works/pi-coding-agent";
import { Text, type Component, type TUI } from "@earendil-works/pi-tui";
import { requestViewedSessionAPI, type ViewedSessionAPI } from "../shared/viewed-session";
import type { Workspace } from "./workspace";
import { GroupViewSelection, rootGroupId, workspaceGroups } from "./group-selection";
import { safe } from "./transcript";

/** A display-only group strip. The prompt and runtime always belong to main. */
export class AgentBar implements Component {
  private api?: ViewedSessionAPI;
  private unsubscribeWorkspace: () => void;
  private unsubscribeView?: () => void;
  private unsubscribeGroup: () => void;
  private disposed = false;
  private cache?: {key: string; lines: string[]};

  constructor(pi: ExtensionAPI, private workspace: Workspace, private tui: TUI, private theme: Theme, private groups = new GroupViewSelection()) {
    this.groups.bind(workspace);
    this.api = requestViewedSessionAPI(pi);
    // Content keys handle in-place mutations; unrelated transcript updates keep layout cached.
    const refresh = () => { if (!this.disposed) this.tui.requestRender(); };
    this.unsubscribeWorkspace = workspace.subscribe(refresh);
    this.unsubscribeView = this.api?.onChange(refresh);
    this.unsubscribeGroup = groups.subscribe(refresh);
  }

  render(width: number): string[] {
    if (this.disposed || this.workspace.closed || width < 1) return [];
    const id = this.groups.id(this.workspace), group = workspaceGroups(this.workspace).find(g => g.id === id);
    const selected = this.api?.getViewedSession()?.id ?? (id === rootGroupId(this.workspace) ? this.workspace.records.get("main")?.identity.instanceId : undefined);
    const records = this.groups.members(this.workspace);
    const key = JSON.stringify([width, id, group?.label, selected, records.map(r => [r.identity.instanceId, r.identity.name, r.template.name, r.status]), ["accent", "muted", "success"].map(c => this.theme.fg(c as "accent" | "muted" | "success", ""))]);
    if (this.cache?.key === key) return this.cache.lines;
    const items = records.map(record => {
      const working = ["starting", "running", "waiting"].includes(record.status);
      const dot = this.theme.fg(working ? "success" : "muted", "●");
      const label = `${safe(record.identity.name).replace(/[\n\r\t]/g, " ")} (${safe(record.template.name).replace(/[\n\r\t]/g, " ")})`;
      return dot + " " + (record.identity.instanceId === selected
        ? this.theme.bold(this.theme.fg("accent", label)) : this.theme.fg("muted", label));
    });
    const content = this.theme.fg("muted", safe(group?.label ?? id).replace(/[\n\r\t]/g, " ") + " · ") + (items.length ? items.join("   ") : this.theme.fg("muted", "No agents"));
    const lines = new Text(content, 0, 0).render(width);
    this.cache = {key, lines}; return lines;
  }

  invalidate(): void { this.cache = undefined; }
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true; this.cache = undefined;
    this.unsubscribeWorkspace(); this.unsubscribeView?.(); this.unsubscribeGroup();
  }
}
