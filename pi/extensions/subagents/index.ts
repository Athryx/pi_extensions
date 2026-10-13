import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { getAgentDir, loadSkills, SettingsManager } from "@earendil-works/pi-coding-agent";
import type { AgentSessionEvent, ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { IDENTITY_KEY, isWorkerSession } from "../shared/agent-role";
import { loadConfig } from "./config";
import { discoverTemplates } from "./templates";
import { customData, TEMPLATE_KEY, DELIVERY_KEY, MAIN_TEMPLATE_LOCK_KEY, mainTemplateLock, hasUserMessage } from "./persistence";
import { promptIdentity, templateLabel, checkTools, loadout, toolEnabled, selection, PI_DEFAULT_TOOLS } from "./loadout";
import { registerTools } from "./tools";
import { message, MESSAGE_KEY } from "./messages";
import { Workspace } from "./workspace";
import { AgentsView } from "./view";
import { AgentViewSelection } from "./selection";
import { AgentBar } from "./agent-bar";
import { GroupViewSelection, rootGroupId } from "./group-selection";
import { GroupView } from "./group-view";
import { registerWorkflowAgents } from "./workflow-agents";
import type { Identity, Selection } from "./types";
export default function subagents(pi: ExtensionAPI) {
  let workspace: Workspace | undefined;
  let selecting = false;
  let lockedTemplate: string | undefined;
  const groups = new GroupViewSelection();
  const viewedAgent = new AgentViewSelection(pi, groups);
  let agentBar: AgentBar | undefined;
  let barContext: ExtensionContext | undefined;
  let closeOverlay: (() => void) | undefined;
  function clearViews(): void { closeOverlay?.(); closeOverlay = undefined; viewedAgent.clear(); }
  function clearBar(): void {
    agentBar?.dispose(); agentBar = undefined;
    barContext?.ui.setWidget("subagents-agent-bar", undefined);
    barContext = undefined;
  }
  const get = () => { if (!workspace || workspace.closed) throw new Error("No interactive workspace is active"); return workspace; };
  // Discover the capability at request time, never capture a replaced workspace.
  registerWorkflowAgents(pi, get, "main");
  async function overlay(current: Workspace, ctx: ExtensionContext, name?: string): Promise<void> {
    viewedAgent.clearTranscript();
    let view: AgentsView | GroupView | undefined;
    let dismiss: (() => void) | undefined;
    const doneView = () => { if (workspace === current && !current.closed) groups.set(current, rootGroupId(current)); };
    try {
      await ctx.ui.custom<void>((tui, theme, _keys, done) => {
        let finished = false;
        const finish = () => { if (finished) return; finished = true; view?.dispose(); doneView(); done(); };
        dismiss = finish; closeOverlay = finish;
        view = groups.members(current).length ? new AgentsView(current, tui, theme, finish, groups, name) : new GroupView(current, groups.id(current), tui, theme, finish);
        return view;
      }, {overlay: true, overlayOptions: {width: "100%", maxHeight: "100%", anchor: "top-left", margin: 0}});
    } finally { view?.dispose(); if (closeOverlay === dismiss) closeOverlay = undefined; }
  }
  function output(ctx: ExtensionContext, content: string, customType: string): void {
    if (ctx.hasUI) ctx.ui.notify(content, "info");
    else if (ctx.mode === "print") process.stdout.write(content + "\n");
    else pi.sendMessage({customType, content, display: true}, {triggerTurn: false});
  }
  const persistTemplate = () => {
    const current = get(); pi.appendEntry(TEMPLATE_KEY, {template: current.get("main").template.name, global: current.global ? {provider: current.global.model.provider, id: current.global.model.id, thinking: current.global.thinking} : undefined});
  };
  function lockTemplate(ctx: ExtensionContext, userMessageStarted = false): void {
    lockedTemplate ??= mainTemplateLock(ctx.sessionManager);
    if (!lockedTemplate && (userMessageStarted || hasUserMessage(ctx.sessionManager))) {
      lockedTemplate = get().get("main").template.name;
      pi.appendEntry(MAIN_TEMPLATE_LOCK_KEY, {version: 1, template: lockedTemplate});
    }
  }
  function rejectLockedTemplate(ctx: ExtensionContext): boolean {
    lockTemplate(ctx);
    if (!lockedTemplate) return false;
    const text = `Main agent template is locked to ${lockedTemplate} after the first user message. Use /new to choose another agent in a new session.`;
    if (!ctx.hasUI) throw new Error(text);
    ctx.ui.notify(text, "warning");
    return true;
  }
  function applyTools() {
    const current = get(), root = current.get("main");
    registerTools(pi, get, "main", !!root.template.subagents.allowed.length);
    const mainOnly = ["finish_plan", "set_goal", "set_goal_status", "ask_question"].filter(n => pi.getAllTools().some(t => t.name === n));
    const names = loadout(root.template, root.settings?.getDefaultTools() ?? PI_DEFAULT_TOOLS, "main", mainOnly);
    if (root.template.tools.include_defaults && names.includes("bash")) {
      for (const name of ["interact_bash", "close_bash"]) if (toolEnabled(root.template, name) && pi.getAllTools().some(t => t.name === name)) names.push(name);
    }
    checkTools(pi, names); pi.setActiveTools([...new Set(names)]);
  }
  async function start(ctx: ExtensionContext, reason?: string) {
    const ephemeralSessions = ["tree", "reload"].includes(reason ?? "") ? workspace?.ephemeralSessions : undefined;
    clearBar(); clearViews();
    await workspace?.close(); workspace = undefined;
    lockedTemplate = undefined;
    if (isWorkerSession(ctx.sessionManager)) return;
    lockedTemplate = mainTemplateLock(ctx.sessionManager);
    const agentDir = getAgentDir(), trusted = ctx.isProjectTrusted();
    const user = await loadConfig(agentDir, ctx.cwd, false), config = await loadConfig(agentDir, ctx.cwd, trusted);
    const {templates, diagnostics} = await discoverTemplates([
      resolve(agentDir, "agents"), ...user.agent_paths,
      ...(trusted ? [resolve(ctx.cwd, ".pi/agents"), ...config.agent_paths.slice(user.agent_paths.length)] : []),
    ]);
    for (const diagnostic of diagnostics) if (ctx.hasUI) ctx.ui.notify(diagnostic, "warning");
    let identity = customData<Identity>(ctx.sessionManager, IDENTITY_KEY).at(-1);
    const file = ctx.sessionManager.getSessionFile();
    if (!identity || reason === "fork" || identity.rootSessionFile !== file) {
      const template = config.default_agent ?? [...templates.values()].find(t => t.selectable)?.name;
      if (!template) throw new Error("No selectable agent templates found; configure default_agent in subagents.json");
      identity = {version: 1, workspaceId: randomUUID(), instanceId: randomUUID(), name: "main", template, role: "interactive", parentName: null, rootSessionFile: file};
      pi.appendEntry(IDENTITY_KEY, identity);
    }
    const saved = customData<{template: string; global?: {provider: string; id: string; thinking: Selection["thinking"]}}>(ctx.sessionManager, TEMPLATE_KEY).at(-1);
    if (saved?.template && templates.has(saved.template)) identity = {...identity, template: saved.template};
    if (lockedTemplate) identity = {...identity, template: lockedTemplate};
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
    groups.bind(workspace);
    // Migrate existing conversations that predate the durable lock marker.
    lockTemplate(ctx);
    applyTools();
    if (ctx.model) {
      const root = workspace.get("main");
      const resolved = selection(root.template, undefined, global, ctx);
      selecting = true;
      try {
        if (!await pi.setModel(resolved.model)) throw new Error("Model credentials unavailable");
        pi.setThinkingLevel(resolved.thinking);
        root.selection = {model: resolved.model, thinking: pi.getThinkingLevel()};
      } finally { selecting = false; }
    }
    if (ctx.mode === "tui") {
      const current = workspace;
      barContext = ctx;
      ctx.ui.setWidget("subagents-agent-bar", (tui, theme) => {
        agentBar?.dispose();
        agentBar = new AgentBar(pi, current, tui, theme, groups);
        return agentBar;
      }, {placement: "belowEditor"});
    }
  }
  for (const [key, direction] of [["alt+]", 1], ["alt+[", -1]] as const) {
    pi.registerShortcut(key, {
      description: direction === 1 ? "View next agent" : "View previous agent",
      handler: async ctx => {
        if (!workspace || workspace.closed || ctx.mode !== "tui") return;
        if (!await viewedAgent.cycle(workspace, direction, ctx))
          ctx.ui.notify("Agent cycling requires the viewed-session UI. Use /subagents for the overlay.", "warning");
      },
    });
  }
  pi.on("session_start", (event, ctx) => start(ctx, event.reason));
  pi.on("session_tree", (_event, ctx) => start(ctx, "tree"));
  pi.on("session_shutdown", async () => { clearBar(); clearViews(); await workspace?.close(); workspace = undefined; lockedTemplate = undefined; });
  pi.on("before_agent_start", (event, ctx) => {
    if (!workspace || isWorkerSession(ctx.sessionManager)) return;
    const root = workspace.get("main");
    root.context = ctx;
    Object.assign(event.systemPromptOptions.sections, promptIdentity(root.identity, root.template, name => workspace!.resolveTemplate(root, name)));
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
      if (event.type === "message_start" && event.message.role === "user") lockTemplate(ctx, true);
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
    description: "Select main's template before the first user message locks it",
    getArgumentCompletions: prefix => workspace ? lockedTemplate ? [] : [...workspace.templates.values()].filter(t => t.selectable !== false && t.name.startsWith(prefix)).map(t => ({value: t.name, label: templateLabel(t)})) : null,
    handler: async (args, ctx) => {
      const current = get();
      if (rejectLockedTemplate(ctx)) return;
      if (!ctx.isIdle()) { ctx.ui.notify("Wait until main is idle before changing its template.", "warning"); return; }
      const templates = [...current.templates.values()].filter(t => t.selectable !== false);
      const labels = templates.map(templateLabel);
      const picked = !args.trim() && ctx.hasUI ? await ctx.ui.select("Main agent template", labels) : undefined;
      const name = args.trim() || (picked === undefined ? undefined : templates[labels.indexOf(picked)]?.name);
      if (!name || current !== workspace || current.closed) return;
      // A prompt can arrive while the picker is open; never apply its stale choice.
      if (rejectLockedTemplate(ctx)) return;
      if (!ctx.isIdle()) { ctx.ui.notify("Wait until main is idle before changing its template.", "warning"); return; }
      const template = current.template(name), root = current.get("main");
      const resolved = selection(template, undefined, current.global, ctx);
      checkTools(pi, loadout(template, root.settings?.getDefaultTools() ?? PI_DEFAULT_TOOLS, "main").filter(n => n !== "create_agent"));
      selecting = true;
      try {
        if (!await pi.setModel(resolved.model)) throw new Error("Model credentials unavailable");
        if (current !== workspace || current.closed || rejectLockedTemplate(ctx)) return;
        pi.setThinkingLevel(resolved.thinking);
        root.template = template; root.identity.template = template.name;
        root.selection = {model: resolved.model, thinking: pi.getThinkingLevel()};
        applyTools(); persistTemplate(); pi.appendEntry(IDENTITY_KEY, root.identity); current.changed();
      } finally { selecting = false; }
    },
  });
  pi.registerCommand("groups", {
    description: "Select a read-only agent group; /groups root restores the root group",
    getArgumentCompletions: prefix => workspace ? [{value: "root", label: "Root group"}, ...groups.tree(workspace).map(row => ({value: row.id, label: row.label}))].filter(row => row.value.startsWith(prefix)) : null,
    handler: async (args, ctx) => {
      const current = get();
      if (ctx.mode !== "tui") { output(ctx, groups.tree(current).map(row => row.label).join("\n"), "subagents.groups.v1"); return; }
      if (!await groups.choose(current, args, (title, options) => ctx.ui.select(title, options)) || current !== workspace || current.closed) return;
      if (!await viewedAgent.selectGroup(current, ctx)) await overlay(current, ctx);
    },
  });
  pi.registerCommand("subagents", {
    description: "View a read-only agent transcript; /subagents main restores main",
    getArgumentCompletions: prefix => workspace ? groups.members(workspace).map(r => r.identity.name).filter(n => n.startsWith(prefix)).map(n => ({value: n, label: n})) : null,
    handler: async (args, ctx) => {
      const current = get();
      if (ctx.mode !== "tui") {
        const content = JSON.stringify(groups.members(current).map(r => ({name: r.identity.name, parent: r.identity.parentName, template: r.template.name, role: r.identity.role, status: r.status})), null, 2);
        output(ctx, content, "subagents.list.v1");
        return;
      }
      if (await viewedAgent.select(current, args, ctx)) return;
      await overlay(current, ctx, args.trim() || undefined);
    },
  });
}
