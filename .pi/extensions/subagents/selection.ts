import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { requestViewedSessionAPI, type ViewedSessionAPI, type ViewedSessionSource } from "../shared/viewed-session";
import type { Workspace } from "./workspace";

/** Select a read-only UI transcript without changing the interactive session. */
export class AgentViewSelection {
  private owned?: { api: ViewedSessionAPI; id: string };

  constructor(private pi: ExtensionAPI) {}

  /** Return false when the legacy overlay should handle the command. */
  async select(workspace: Workspace, args: string, ctx: ExtensionContext): Promise<boolean> {
    if (ctx.mode !== "tui") return false;
    const api = requestViewedSessionAPI(this.pi);
    if (!api?.available) return false;
    const name = args.trim() || await ctx.ui.select("View agent (read-only)", [...workspace.records.keys()]);
    // A root switch can close the workspace while the native picker is open.
    if (!name || workspace.closed) return true;
    if (name === "main") {
      const restored = api.setViewedSession(undefined);
      if (restored) this.owned = undefined;
      return restored;
    }
    const record = workspace.get(name);
    const source: ViewedSessionSource = {
      id: record.identity.instanceId,
      title: record.identity.name,
      // Idle workers can acquire/recreate sessions after this source is selected.
      getSnapshot: () => ({
        messages: record.messages,
        session: record.session,
        manager: record.manager,
        settings: record.settings,
        toolUpdates: record.toolUpdates,
      }),
      subscribe: listener => workspace.subscribe(listener),
    };
    if (!api.setViewedSession(source)) return false;
    this.owned = {api, id: source.id};
    return true;
  }

  /** Drop old workspace references on reload, navigation, replacement or shutdown. */
  clear(): void {
    const owned = this.owned;
    this.owned = undefined;
    if (owned && owned.api.getViewedSession()?.id === owned.id) owned.api.setViewedSession(undefined);
  }
}
