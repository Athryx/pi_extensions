import { Type, type TProperties } from "typebox";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { Workspace } from "./workspace";
import type { Identity } from "./types";
import { isGroupRoot } from "./loadout";
const object = <T extends TProperties>(fields: T) => Type.Object(fields, {additionalProperties: false});
function result(value: unknown, description?: string) {
  return {content: [{type: "text" as const, text: description ?? JSON.stringify(value, null, 2)}], details: value, structuredContent: JSON.parse(JSON.stringify(value))};
}
export function registerTools(pi: ExtensionAPI, workspace: () => Workspace, name: string, allowCreate: boolean, identity?: Identity): void {
  pi.registerTool({
    exposure: allowCreate ? "direct" : "hidden",
    name: "create_agent", label: "Create agent", executionMode: "parallel",
    description: "Start a named child asynchronously. A null template requires a configured default. Names are workspace-unique.",
    parameters: object({name: Type.String(), task: Type.String(), agent_template: Type.Optional(Type.Union([Type.String(), Type.Null()]))}),
    outputSchema: object({name: Type.String(), status: Type.Literal("started")}),
    async execute(_id, args, signal) {
      await workspace().create(name, args.name, args.task, args.agent_template, signal);
      return result({name: args.name, status: "started"}, "Agent " + args.name + " started.");
    },
  });
  const exposure = (identity ? isGroupRoot(identity) : name === "main") && !allowCreate ? "hidden" : "direct";
  pi.registerTool({
    exposure,
    name: "send_message", label: "Send message", executionMode: "parallel",
    description: "Send attributed steering context to an agent in your own group. Resumes idle agents in their existing session.",
    parameters: object({agent_name: Type.String(), message: Type.String()}),
    outputSchema: object({id: Type.String(), status: Type.Literal("queued")}),
    async execute(_id, args) { const id = await workspace().send(name, args.agent_name, args.message); return result({id, status: "queued"}); },
  });
  pi.registerTool({
    exposure,
    name: "wait_message", label: "Wait for message", executionMode: "parallel",
    description: "Wait for a message in your agent group; timeout is seconds, default 120, maximum 600. Refuses when nobody else can make progress.",
    parameters: object({timeout: Type.Optional(Type.Number({exclusiveMinimum: 0, maximum: 600}))}),
    async execute(_id, args, signal) { return result(await workspace().wait(name, args.timeout ?? 120, signal)); },
  });
  pi.registerTool({
    exposure,
    name: "list_agents", label: "List agents", executionMode: "parallel",
    description: "List direct children (including idle children). all=true lists your own agent group and parent relationships.",
    parameters: object({all: Type.Optional(Type.Boolean())}),
    outputSchema: Type.Array(object({name: Type.String(), parent: Type.Union([Type.String(), Type.Null()]), template: Type.String(), role: Type.String(), status: Type.String(), model: Type.Optional(Type.String()), thinking: Type.Optional(Type.String()), error: Type.Optional(Type.String())})),
    async execute(_id, args) { return result(workspace().list(name, args.all ?? false)); },
  });
}
