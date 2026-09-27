import { getAgentDir, SettingsManager, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createBashToolDefinition } from "./tool.ts";

/** Project-local bash override; execution lives entirely in this directory. */
export default function (pi: ExtensionAPI) {
  pi.on("session_start", (_event, ctx) => {
    // Read the same effective shell settings pi uses for its built-in bash tool.
    const settings = SettingsManager.create(ctx.cwd, getAgentDir(), {
      projectTrusted: ctx.isProjectTrusted(),
    });
    pi.registerTool(createBashToolDefinition(ctx.cwd, {
      shellPath: settings.getShellPath(),
      commandPrefix: settings.getShellCommandPrefix(),
    }));
  });
}
