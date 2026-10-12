import { getAgentDir, SettingsManager, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createBashTools } from "./tool.ts";
import type { StoppedBashSession } from "./session.ts";

/** Project-local bash override; execution lives entirely in this directory. */
export default function (pi: ExtensionAPI) {
  let shutdown: (() => Promise<StoppedBashSession[]>) | undefined;
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
    const stopped = await shutdown?.();
    shutdown = undefined;
    if (!stopped?.length) return;

    const list = stopped.map(({ name, outputPath }) => `- ${name}: ${outputPath}`).join("\n");
    pi.sendMessage({
      customType: "bash-session-shutdown",
      content: `The following background bash sessions were stopped when this Pi session shut down. They cannot be resumed or accessed with interact_bash; their output logs remain available:\n${list}`,
      display: true,
    }, { triggerTurn: false });
  });
}
