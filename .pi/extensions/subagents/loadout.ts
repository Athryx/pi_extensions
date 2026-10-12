import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import type { Selection, Template, Identity } from "./types";
export const COMMS = ["send_message", "wait_message", "list_agents"];
export const PI_DEFAULT_TOOLS = ["read", "bash", "edit", "write"];
export function loadout(template: Template, defaults: readonly string[] = PI_DEFAULT_TOOLS): string[] {
  return [...new Set([...(template.tools.include_defaults ? defaults : []), ...template.tools.extra, ...COMMS, ...(template.subagents.allowed.length ? ["create_agent"] : [])])];
}
export function checkTools(pi: ExtensionAPI, names: string[]): void {
  const known = new Set(pi.getAllTools().map(t => t.name));
  for (const name of names) if (!known.has(name)) throw new Error("Unknown/unavailable tool: " + name);
}
export function selection(template: Template, parent: Selection | undefined, global: Selection | undefined, ctx: Pick<ExtensionContext, "modelRegistry">): Selection {
  const inherit = parent ?? global;
  let model = template.model.name === "global" ? global?.model : template.model.name === "parent" ? inherit?.model : undefined;
  if (!["parent", "global"].includes(template.model.name)) {
    const slash = template.model.name.indexOf("/");
    model = ctx.modelRegistry.find(template.model.name.slice(0, slash), template.model.name.slice(slash + 1));
  }
  if (!model) throw new Error("No available model for " + template.model.name);
  const thinking = template.model.thinking === "global" ? global?.thinking : template.model.thinking === "parent" ? inherit?.thinking : template.model.thinking as ThinkingLevel;
  return {model, thinking: thinking ?? "medium"};
}
export function promptIdentity(identity: Identity, template: Template): Record<string, string> {
  return {
    agent_identity: "Instance: " + identity.name + ". Role: " + identity.role + ". Parent: " + (identity.parentName ?? "none") + ".",
    agent_template: template.prompt,
    agent_workspace: "Messages are attributed to their sender. send_message queues steering context and resumes idle agents. wait_message waits up to 600 seconds, but refuses deadlock. Your final answer is automatically sent to your parent if present. Allowed child templates: " + (template.subagents.allowed.join(", ") || "none") + ". Default child: " + (template.subagents.default ?? "none; specify agent_template") + ".",
  };
}
