import { basename, dirname, resolve } from "node:path";
import {
  createAgentSession, DefaultPackageManager, DefaultResourceLoader, SettingsManager, ModelRuntime,
  createCodemodeExtension, createToolSearchExtension, createMcpExtension,
} from "@earendil-works/pi-coding-agent";
import type { ExtensionContext, ExtensionFactory } from "@earendil-works/pi-coding-agent";
import { loadout, checkTools, promptIdentity, PI_DEFAULT_TOOLS } from "./loadout";
import { isInteractiveTool } from "../shared/interactive";
import { registerTools } from "./tools";
import { registerWorkflowAgents } from "./workflow-agents";
import type { AgentRecord } from "./types";
import type { Workspace } from "./workspace";
export const MAIN_ONLY = new Set(["subagents", "context", "ui", "codex-usage"]);
export function excluded(path: string, extra: string[]): boolean {
  const component = /\.[cm]?[jt]s$/.test(path) ? basename(path).replace(/\.[cm]?[jt]s$/, "") : basename(path);
  return extra.includes(resolve(path)) || MAIN_ONLY.has(component) || MAIN_ONLY.has(basename(dirname(path)));
}
export async function syncModelAccess(runtime: ModelRuntime, record: AgentRecord, ctx: ExtensionContext): Promise<void> {
  const model = record.selection!.model;
  const native = ctx.modelRegistry.getRegisteredNativeProvider(model.provider);
  const config = ctx.modelRegistry.getRegisteredProviderConfig(model.provider);
  if (native) runtime.registerNativeProvider(native);
  else if (config) runtime.registerProvider(model.provider, config);
  const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
  if (!auth.ok) throw new Error(auth.error);
  if (auth.apiKey && !ctx.modelRegistry.isUsingOAuth(model)) await runtime.setRuntimeApiKey(model.provider, auth.apiKey);
}
export async function makeWorker(workspace: Workspace, record: AgentRecord, ctx: ExtensionContext): Promise<void> {
  const startupSignal = AbortSignal.any([workspace.signal.signal, record.taskController?.signal ?? workspace.signal.signal]);
  startupSignal.throwIfAborted();
  const settings = SettingsManager.create(workspace.cwd, workspace.agentDir);
  settings.setProjectTrusted(workspace.trusted);
  await settings.reload();
  const paths = await new DefaultPackageManager({cwd: workspace.cwd, agentDir: workspace.agentDir, settingsManager: settings}).resolve(() => Promise.resolve("skip"));
  const extensions = paths.extensions.filter(p => p.enabled && !excluded(p.path, workspace.config.worker_exclude_extensions)).map(p => p.path);
  const allowed = new Set(loadout(record.template, settings.getDefaultTools() ?? PI_DEFAULT_TOOLS, record.identity));
  const factory: ExtensionFactory = pi => {
    registerTools(pi, () => workspace, record.identity.name, !!record.template.subagents.allowed.length, record.identity);
    registerWorkflowAgents(pi, () => workspace, record.identity.name);
    pi.on("before_agent_start", event => {
      Object.assign(event.systemPromptOptions.sections, promptIdentity(record.identity, record.template, name => workspace.resolveTemplate(record, name)));
    });
    pi.on("tool_call", event => {
      if (!allowed.has(event.toolName)) return {block: true, reason: "Tool not permitted by agent template: " + event.toolName};
    });
    const apply = () => {
      // Interactive helpers register hidden definitions headlessly, including late session_start tools.
      for (const tool of pi.getAllTools()) if (tool.exposure === "hidden") allowed.delete(tool.name);
      if (record.template.tools.include_defaults && allowed.has("bash")) for (const name of ["interact_bash", "close_bash"]) {
        if (pi.getAllTools().some(t => t.name === name)) allowed.add(name);
      }
      checkTools(pi, [...allowed].filter(name => !name.startsWith("mcp__"))); pi.setActiveTools([...allowed]);
    };
    pi.on("turn_start", () => pi.setActiveTools([...allowed]));
    pi.on("session_start", apply);
    pi.on("mcp_servers_change", () => { pi.setActiveTools([...allowed]); });
  };
  const loader = new DefaultResourceLoader({
    cwd: workspace.cwd, agentDir: workspace.agentDir, settingsManager: settings,
    noExtensions: true, additionalExtensionPaths: extensions,
    extensionFactories: [factory, {name: "codemode", replaceable: true, factory: createCodemodeExtension()}, {name: "tool-search", replaceable: true, factory: createToolSearchExtension()}, {name: "mcp", replaceable: true, factory: createMcpExtension()}],
    noSkills: !record.template.skills.include_defaults, additionalSkillPaths: record.template.skills.extra_paths,
    extensionsOverride: base => {
      // Enhanced bash uses companion tools for background sessions; retain them with default bash.
      if (record.template.tools.include_defaults && allowed.has("bash")) for (const name of ["interact_bash", "close_bash"]) {
        if (base.extensions.some(extension => extension.tools.has(name))) allowed.add(name);
      }
      // Hide unselected initial registrations from codemode/search as well as direct declarations.
      for (const extension of base.extensions) for (const [name, tool] of extension.tools) {
        if (isInteractiveTool(tool.definition)) allowed.delete(name);
        if (!allowed.has(name)) extension.tools.set(name, {...tool, definition: {...tool.definition, exposure: "hidden", promptSnippet: undefined, promptGuidelines: undefined}});
      }
      return base;
    },
  });
  await loader.reload(); startupSignal.throwIfAborted();
  const errors = loader.getExtensions().errors;
  if (errors.length) throw new Error(errors.map(e => e.path + ": " + e.error).join("\n"));
  const runtime = await ModelRuntime.create({authPath: resolve(workspace.agentDir, "auth.json"), modelsPath: resolve(workspace.agentDir, "models.json"), signal: workspace.signal.signal});
  // Copy configured provider definitions and runtime credentials through public APIs.
  for (const id of ctx.modelRegistry.getRegisteredProviderIds()) {
    const native = ctx.modelRegistry.getRegisteredNativeProvider(id), config = ctx.modelRegistry.getRegisteredProviderConfig(id);
    if (native) runtime.registerNativeProvider(native);
    else if (config) runtime.registerProvider(id, config);
  }
  const model = record.selection!.model;
  await syncModelAccess(runtime, record, ctx);
  const {session} = await createAgentSession({
    cwd: workspace.cwd, agentDir: workspace.agentDir, settingsManager: settings, resourceLoader: loader,
    sessionManager: record.manager, modelRuntime: runtime, model, thinkingLevel: record.selection!.thinking,
    // Reserve optional companion names in the immutable SDK selector: enhanced bash registers them on session_start.
    tools: [...allowed, ...(record.template.tools.include_defaults && allowed.has("bash") ? ["interact_bash", "close_bash"] : [])],
  });
  record.session = session;
  try {
    await session.bindExtensions({mode: "print", shutdownHandler: () => { record.session?.abort().catch(() => {}); }});
    // Named MCP tools arrive asynchronously. Give configured providers a bounded preflight window.
    const requiredMcp = [...allowed].filter(name => name.startsWith("mcp__"));
    const deadline = Date.now() + 10000;
    while (requiredMcp.some(name => !session.getAllTools().some(t => t.name === name)) && Date.now() < deadline) {
      startupSignal.throwIfAborted();
      await new Promise(resolve => setTimeout(resolve, 25));
    }
    startupSignal.throwIfAborted();
    const names = new Set(session.getAllTools().map(t => t.name));
    for (const name of allowed) if (!names.has(name)) throw new Error("Unknown/unavailable tool: " + name);
    session.setActiveToolsByName([...allowed]);
    record.selection = {model: session.model!, thinking: session.thinkingLevel};
    record.messages = [...session.messages];
    record.unsubscribe = session.subscribe(event => workspace.observe(record, event));
  } catch (e) {
    await session.abort();
    try { await session.extensionRunner.emit({type: "session_shutdown", reason: "quit"}); }
    finally { session.dispose(); record.session = undefined; }
    throw e;
  }
}
