import { randomUUID } from "node:crypto";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { getAgentDir, loadSkills, SettingsManager } from "@earendil-works/pi-coding-agent";
import type { AgentSessionEvent, ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { IDENTITY_KEY, isWorkerSession } from "../shared/agent-role";
import { loadConfig } from "./config";
import { discoverTemplates } from "./templates";
import { customData, TEMPLATE_KEY, DELIVERY_KEY } from "./persistence";
import { promptIdentity, checkTools, loadout, selection, COMMS, PI_DEFAULT_TOOLS } from "./loadout";
import { registerTools } from "./tools";
import { message, MESSAGE_KEY } from "./messages";
import { Workspace } from "./workspace";
import { AgentsView } from "./view";
import type { Identity, Selection } from "./types";
export default function subagents(pi: ExtensionAPI) {
  const defaultsDir = resolve(dirname(fileURLToPath(import.meta.url)), "defaults");
  let workspace: Workspace | undefined;
  let originalTools: string[] | undefined;
  let selecting = false;
  const get = () => { if (!workspace || workspace.closed) throw new Error("No interactive workspace is active"); return workspace; };
  const persistTemplate = () => {
    const current = get(); pi.appendEntry(TEMPLATE_KEY, {template: current.get("main").template.name, global: current.global ? {provider: current.global.model.provider, id: current.global.model.id, thinking: current.global.thinking} : undefined});
  };
  function applyTools() {
    const current = get(), root = current.get("main");
    registerTools(pi, get, "main", !!root.template.subagents.allowed.length);
    const mainOnly = ["finish_plan", "set_goal", "set_goal_status", "ask_question"].filter(n => pi.getAllTools().some(t => t.name === n));
    const names = root.template.source === resolve(defaultsDir, "main.yaml")
      ? [...(originalTools ?? []), ...COMMS, ...(root.template.subagents.allowed.length ? ["create_agent"] : [])]
      : [...loadout(root.template, root.settings?.getDefaultTools() ?? PI_DEFAULT_TOOLS), ...mainOnly];
    checkTools(pi, names); pi.setActiveTools([...new Set(names)]);
  }
  async function start(ctx: ExtensionContext, reason?: string) {
    const ephemeralSessions = ["tree", "reload"].includes(reason ?? "") ? workspace?.ephemeralSessions : undefined;
    await workspace?.close(); workspace = undefined;
    if (isWorkerSession(ctx.sessionManager)) return;
    const agentDir = getAgentDir(), trusted = ctx.isProjectTrusted();
    const user = await loadConfig(agentDir, ctx.cwd, false), config = await loadConfig(agentDir, ctx.cwd, trusted);
    const {templates, diagnostics} = await discoverTemplates([
      defaultsDir, resolve(agentDir, "agents"), ...user.agent_paths,
      ...(trusted ? [resolve(ctx.cwd, ".pi/agents"), ...config.agent_paths.slice(user.agent_paths.length)] : []),
    ]);
    for (const diagnostic of diagnostics) if (ctx.hasUI) ctx.ui.notify(diagnostic, "warning");
    let identity = customData<Identity>(ctx.sessionManager, IDENTITY_KEY).at(-1);
    const file = ctx.sessionManager.getSessionFile();
    if (!identity || reason === "fork" || identity.rootSessionFile !== file) {
      identity = {version: 1, workspaceId: randomUUID(), instanceId: randomUUID(), name: "main", template: "main", role: "interactive", parentName: null, rootSessionFile: file};
      pi.appendEntry(IDENTITY_KEY, identity);
    }
    const saved = customData<{template: string; global?: {provider: string; id: string; thinking: Selection["thinking"]}}>(ctx.sessionManager, TEMPLATE_KEY).at(-1);
    if (saved?.template && templates.has(saved.template)) identity = {...identity, template: saved.template};
    if (!templates.has(identity.template)) throw new Error("Selected template is unavailable: " + identity.template);
    let global: Selection | undefined = ctx.model ? {model: ctx.model, thinking: ctx.thinkingLevel ?? "medium"} : undefined;
    if (saved?.global) { const model = ctx.modelRegistry.find(saved.global.provider, saved.global.id); if (model) global = {model, thinking: saved.global.thinking}; }
    workspace = new Workspace({
      cwd: ctx.cwd, agentDir, trusted, config, templates, identity, context: ctx, global, ephemeralSessions,
      append: (key, value) => pi.appendEntry(key, value),
      rootSend: (envelope, startTurn) => pi.sendMessage(message(envelope), {deliverAs: "steer", triggerTurn: startTurn}),
    });
    workspace.get("main").settings = SettingsManager.create(ctx.cwd, agentDir, {projectTrusted: trusted});
    await workspace.get("main").settings!.reload();
    await workspace.restore();
    originalTools ??= pi.getActiveTools().filter(n => ![...COMMS, "create_agent"].includes(n));
    applyTools();
  }
  pi.on("session_start", (event, ctx) => start(ctx, event.reason));
  pi.on("session_tree", (_event, ctx) => start(ctx, "tree"));
  pi.on("session_shutdown", async () => { await workspace?.close(); workspace = undefined; });
  pi.on("before_agent_start", (event, ctx) => {
    if (!workspace || isWorkerSession(ctx.sessionManager)) return;
    const root = workspace.get("main");
    root.context = ctx;
    Object.assign(event.systemPromptOptions.sections, promptIdentity(root.identity, root.template));
    const extra = loadSkills({cwd: ctx.cwd, agentDir: workspace.agentDir, skillPaths: root.template.skills.extra_paths, includeDefaults: false});
    const base = root.template.skills.include_defaults ? event.systemPromptOptions.skills : [];
    event.systemPromptOptions.skills = [...new Map([...base, ...extra.skills].map(s => [s.name, s])).values()];
    workspace.setMainStatus("running", ctx);
  });
  pi.on("agent_start", (_event, ctx) => workspace?.setMainStatus("running", ctx));
  pi.on("agent_settled", (_event, ctx) => {
    if (!workspace) return;
    workspace.get("main").messages = ctx.sessionManager.buildSessionProjection().messages;
    workspace.setMainStatus("idle", ctx);
  });
  const observeRoot = (event: AgentSessionEvent, ctx: ExtensionContext) => {
      if (!workspace) return;
      const root = workspace.get("main");
      root.messages = ctx.sessionManager.buildSessionProjection().messages;
      if ((event.type === "message_update" || event.type === "message_end") && "message" in event && !root.messages.some(m => m.role === event.message.role && m.timestamp === event.message.timestamp)) root.messages = [...root.messages, event.message];
      if (event.type === "message_end" && "message" in event && event.message.role === "custom" && event.message.customType === MESSAGE_KEY) pi.appendEntry(DELIVERY_KEY, {envelope: event.message.details, delivered: true});
      if ("toolCallId" in event) { root.toolUpdates ??= new Map(); root.toolUpdates.set(event.toolCallId, event); }
      workspace.changed();
  };
  pi.on("message_start", observeRoot);
  pi.on("message_update", observeRoot);
  pi.on("message_end", observeRoot);
  pi.on("tool_execution_start", observeRoot);
  pi.on("tool_execution_update", observeRoot);
  pi.on("tool_execution_end", observeRoot);
  pi.on("model_select", (event, ctx) => {
    if (!workspace || selecting) return;
    workspace.global = {model: event.model, thinking: ctx.thinkingLevel ?? pi.getThinkingLevel()};
    workspace.get("main").selection = workspace.global; persistTemplate();
  });
  pi.on("thinking_level_select", (event, ctx) => {
    if (!workspace || selecting || !workspace.global) return;
    workspace.global = {...workspace.global, thinking: event.level};
    const root = workspace.get("main");
    if (ctx.model) root.selection = {model: ctx.model, thinking: event.level};
    persistTemplate();
  });
  pi.registerCommand("agent", {
    description: "Select the template for the main interactive agent",
    getArgumentCompletions: prefix => workspace ? [...workspace.templates.keys()].filter(n => n.startsWith(prefix)).map(n => ({value: n, label: n})) : null,
    handler: async (args, ctx) => {
      const current = get();
      if (!ctx.isIdle()) { ctx.ui.notify("Wait until main is idle before changing its template.", "warning"); return; }
      const name = args.trim() || (ctx.hasUI ? await ctx.ui.select("Main agent template", [...current.templates.keys()]) : undefined);
      if (!name) return;
      const template = current.template(name), root = current.get("main");
      const resolved = selection(template, undefined, current.global, ctx);
      checkTools(pi, loadout(template, root.settings?.getDefaultTools() ?? PI_DEFAULT_TOOLS).filter(n => n !== "create_agent"));
      selecting = true;
      try {
        if (!await pi.setModel(resolved.model)) throw new Error("Model credentials unavailable");
        pi.setThinkingLevel(resolved.thinking);
        root.template = template; root.identity.template = template.name;
        root.selection = {model: resolved.model, thinking: pi.getThinkingLevel()};
        applyTools(); persistTemplate(); pi.appendEntry(IDENTITY_KEY, root.identity); current.changed();
      } finally { selecting = false; }
    },
  });
  pi.registerCommand("agents", {
    description: "Read-only live workspace transcripts; cycle agents and inspect idle workers",
    handler: async (_args, ctx) => {
      const current = get();
      if (ctx.mode !== "tui") {
        const content = JSON.stringify(current.list("main", true), null, 2);
        if (ctx.hasUI) ctx.ui.notify(content, "info");
        else if (ctx.mode === "print") process.stdout.write(content + "\n");
        else pi.sendMessage({customType: "subagents.list.v1", content, display: true}, {triggerTurn: false});
        return;
      }
      let view: AgentsView | undefined;
      try { await ctx.ui.custom<void>((tui, theme, _keys, done) => { view = new AgentsView(current, tui, theme, done); return view; }, {overlay: true, overlayOptions: {width: "100%", maxHeight: "100%", anchor: "top-left", margin: 0}}); }
      finally { view?.dispose(); }
    },
  });
}
