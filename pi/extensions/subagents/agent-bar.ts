import type { ExtensionAPI, Theme } from "@earendil-works/pi-coding-agent";
import { Text, type Component, type TUI } from "@earendil-works/pi-tui";
import { requestViewedSessionAPI, type ViewedSessionAPI } from "../shared/viewed-session";
import type { Workspace } from "./workspace";

/** A display-only workspace strip. The prompt and runtime always belong to main. */
export class AgentBar implements Component {
  private api?: ViewedSessionAPI;
  private unsubscribeWorkspace: () => void;
  private unsubscribeView?: () => void;
  private disposed = false;

  constructor(pi: ExtensionAPI, private workspace: Workspace, private tui: TUI, private theme: Theme) {
    this.api = requestViewedSessionAPI(pi);
    const refresh = () => { if (!this.disposed) this.tui.requestRender(); };
    this.unsubscribeWorkspace = workspace.subscribe(refresh);
    this.unsubscribeView = this.api?.onChange(refresh);
  }

  render(width: number): string[] {
    if (this.disposed || this.workspace.closed || width < 1) return [];
    const selected = this.api?.getViewedSession()?.id ?? this.workspace.get("main").identity.instanceId;
    const items = [...this.workspace.records.values()].map(record => {
      const working = ["starting", "running", "waiting"].includes(record.status);
      const dot = this.theme.fg(working ? "success" : "muted", "●");
      // Names/templates may come from persisted sessions; never render control codes.
      const clean = (value: string) => value.replace(/[\x00-\x1f\x7f-\x9f]/g, "");
      const label = `${clean(record.identity.name)} (${clean(record.template.name)})`;
      return dot + " " + (record.identity.instanceId === selected
        ? this.theme.bold(this.theme.fg("accent", label)) : this.theme.fg("muted", label));
    });
    return new Text(items.join("   "), 0, 0).render(width);
  }

  invalidate(): void {}
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.unsubscribeWorkspace();
    this.unsubscribeView?.();
  }
}
