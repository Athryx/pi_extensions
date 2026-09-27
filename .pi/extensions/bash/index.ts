import { getAgentDir, SettingsManager, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createBashTools } from "./tool.ts";

/** Project-local bash override; execution lives entirely in this directory. */
export default function (pi: ExtensionAPI) {
  let shutdown: (() => Promise<void>) | undefined;
  pi.on("session_start", (_event, ctx) => {
    // Read the same effective shell settings pi uses for its built-in bash tool.
    const settings = SettingsManager.create(ctx.cwd, getAgentDir(), {
      projectTrusted: ctx.isProjectTrusted(),
    });
    const manager = createBashTools(ctx.cwd, {
      shellPath: settings.getShellPath(),
      commandPrefix: settings.getShellCommandPrefix(),
    });
    shutdown = manager.shutdown;
    for (const tool of manager.tools) pi.registerTool(tool);
  });
  pi.on("session_shutdown", async () => {
    await shutdown?.();
    shutdown = undefined;
  });
}
