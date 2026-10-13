import { randomUUID } from "node:crypto";
import { isAbsolute, basename } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { WORKFLOW_AGENTS_REQUEST } from "../shared/workflow-agents";
import type { WorkflowAgentsAPI, WorkflowAgentsRequest, WorkflowAgentRun } from "../shared/workflow-agents";
import { normalizeTemplate, validName } from "./templates";
import { object } from "./config";
import { applyModifiers } from "./modifiers";
import { groupId } from "./groups";
import type { Template, WorkflowRegistry, WorkflowRegistrySnapshot } from "./types";
import type { Workspace } from "./workspace";

function freeze<T>(value: T): T {
  if (value && typeof value === "object") { Object.values(value).forEach(freeze); Object.freeze(value); }
  return value;
}
export function publicTemplate(t: Template): unknown {
  return {name: t.name, ...(t.description !== undefined ? {description: t.description} : {}), selectable: t.selectable, model: t.model, tools: t.tools, skills: t.skills, prompt: t.prompt,
    subagents: {include_defaults: false, extra: t.subagents.allowed, ...(t.subagents.default ? {default: t.subagents.default} : {})}};
}
/** Re-normalize snapshots, never trust internal permission metadata from session JSON. */
export function restoreRegistry(raw: unknown): WorkflowRegistry {
  const data = object(raw, ["version", "id", "sourcePath", "definitions", "globals"], "workflow registry");
  groupId(data.id);
  if (data.version !== 1 || typeof data.sourcePath !== "string" || !isAbsolute(data.sourcePath) || data.sourcePath.includes("\0")) throw new Error("Invalid workflow registry source");
  if (!Array.isArray(data.definitions) || !Array.isArray(data.globals) || data.definitions.length > 128 || data.globals.length > 128 || Buffer.byteLength(JSON.stringify(data)) > 1024 * 1024) throw new Error("Workflow registry exceeds limits");
  const globals = new Map<string, Template>();
  for (const raw of data.globals) {
    const template = normalizeTemplate(raw, data.sourcePath);
    if (globals.has(template.name)) throw new Error("Duplicate global registry template: " + template.name);
    globals.set(template.name, template);
  }
  const locals = new Map<string, Template>();
  for (const raw of data.definitions) {
    const template = normalizeTemplate(raw, data.sourcePath);
    if (locals.has(template.name)) throw new Error("Duplicate workflow agent: " + template.name);
    locals.set(template.name, template);
  }
  const templates = new Map([...globals, ...locals]);
  for (const template of locals.values()) {
    for (const name of [...applyModifiers([], template.subagents.extra), ...(template.subagents.default ? [template.subagents.default] : [])]) {
      if (!templates.has(name)) throw new Error("Missing or disallowed child template: " + name);
    }
    template.subagents.allowed = applyModifiers(template.subagents.include_defaults ? templates.keys() : [], template.subagents.extra);
  }
  for (const t of templates.values()) freeze(t);
  return {snapshot: freeze(structuredClone(data) as unknown as WorkflowRegistrySnapshot), templates, localNames: new Set(locals.keys())};
}

export function workflowAgentsAPI(workspace: Workspace, callerName: string): WorkflowAgentsAPI {
  const caller = workspace.get(callerName);
  return {
    version: 1,
    getProgress: () => [...workspace.workflowProgress.values()].map(p => structuredClone(p)),
    subscribeProgress: listener => workspace.subscribe(listener),
    openRun(options): WorkflowAgentRun {
      const checked = object(options, ["sourcePath", "signal"], "workflow run");
      if (typeof checked.sourcePath !== "string" || !isAbsolute(checked.sourcePath) || !(checked.signal instanceof AbortSignal)) throw new Error("Invalid workflow run options");
      if (workspace.get(callerName) !== caller) throw new Error("Workflow caller expired");
      options.signal.throwIfAborted();
      const id = randomUUID();
      const group = workspace.addGroup({version: 1, id: randomUUID(), parentGroupId: workspace.agentGroupId(caller.identity), kind: "workflow", label: "Workflow: " + basename(options.sourcePath).slice(0, 150), rootAgentInstanceId: null, workflowRunId: id, status: "running"});
      // Authority is captured once at invocation; no later global allowlist mutation broadens it.
      const globals = caller.template.subagents.allowed
        .filter(name => !caller.workflowRegistry?.localNames.has(name) && workspace.templates.has(name))
        .map(name => publicTemplate(workspace.template(name)));
      let registry = restoreRegistry({version: 1, id: randomUUID(), sourcePath: options.sourcePath, definitions: [], globals});
      let closed = false, closing: Promise<void> | undefined;
      const controller = new AbortController();
      const pending = new Set<Promise<unknown>>();
      const ensure = () => { if (closed || workspace.closed) throw new Error("Workflow run is closed"); controller.signal.throwIfAborted(); };
      const abort = () => { void close("Workflow run cancelled").catch(() => {}); };
      options.signal.addEventListener("abort", abort, {once: true});
      workspace.signal.signal.addEventListener("abort", abort, {once: true});
      const close = (reason?: string): Promise<void> => {
        if (closing) return closing;
        closed = true; controller.abort(reason ?? "Workflow run closed");
        options.signal.removeEventListener("abort", abort); workspace.signal.signal.removeEventListener("abort", abort);
        closing = (async () => {
          await workspace.cancelOwnedRun(id);
          await Promise.allSettled([...pending]);
          workspace.workflowProgress.delete(id);
          workspace.updateGroup(group.id, {status: reason ? "cancelled" : "completed"});
        })();
        return closing;
      };
      return {
        id,
        async cancelAgents(signal) { await workspace.cancelWorkflowScope(id, signal); },
        async registerAgents(definitions) {
          ensure();
          if (!Array.isArray(definitions)) throw new Error("Agent definitions must be an array");
          // Validation of the complete candidate is atomic and permits forward/mutual references.
          registry = restoreRegistry({...registry.snapshot, id: randomUUID(), definitions: [...registry.snapshot.definitions, ...structuredClone(definitions)]});
        },
        async agent(prompt, templateName, prefix, signal, onUpdate) {
          ensure();
          if (typeof templateName !== "string") throw new Error("Agent template must be explicit");
          validName(templateName);
          const template = registry.templates.get(templateName);
          if (!template) throw new Error("Unknown or disallowed workflow template: " + templateName);
          const name = workspace.reserveWorkflowName(prefix ?? templateName);
          const agentGroup = workspace.addGroup({version: 1, id: randomUUID(), parentGroupId: group.id, kind: "agents", label: "Agent: " + name, agentName: name, rootAgentInstanceId: null, workflowRunId: id, status: "queued"});
          onUpdate?.({name, groupId: agentGroup.id, status: "queued"});
          const operation = workspace.launchWorkflow(callerName, name, prompt, template, agentGroup.id, id,
            registry.localNames.has(templateName) ? registry : undefined, [controller.signal, signal], () => onUpdate?.({name, groupId: agentGroup.id, status: "running"}));
          pending.add(operation);
          void operation.finally(() => pending.delete(operation)).catch(() => {});
          return operation;
        },
        updateProgress(details) {
          // Terminal adapter cleanup may publish after the host abort listener closed this run.
          // Ignore late snapshots rather than interrupt cancellation/output cleanup.
          if (closed || workspace.closed || controller.signal.aborted) return;
          const copy = structuredClone(details);
          if (Buffer.byteLength(JSON.stringify(copy) ?? "") > 4 * 1024 * 1024) throw new Error("Workflow progress exceeds limits");
          workspace.workflowProgress.set(id, {id, owner: callerName, details: copy}); workspace.changed();
        },
        close,
      };
    },
  };
}
export function registerWorkflowAgents(pi: ExtensionAPI, getWorkspace: () => Workspace, callerName: string): void {
  pi.events.on(WORKFLOW_AGENTS_REQUEST, (raw: unknown) => {
    const request = raw as WorkflowAgentsRequest;
    if (!request || typeof request.reply !== "function") return;
    let workspace: Workspace;
    try { workspace = getWorkspace(); } catch { return; }
    if (workspace.closed || !workspace.records.has(callerName)) return;
    request.reply(workflowAgentsAPI(workspace, callerName));
  });
}
