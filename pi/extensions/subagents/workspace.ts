import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import type { AgentSessionEvent, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { IDENTITY_KEY } from "../shared/agent-role";
import { customData, MEMBER_KEY, DELIVERY_KEY, STATE_KEY, GROUP_KEY, REGISTRY_KEY, workspaceData, workspaceFile } from "./persistence";
import { selection, isGroupRoot } from "./loadout";
import { normalizeGroup, normalizeOwnership, validateGroups } from "./groups";
import { publicTemplate, restoreRegistry } from "./workflow-agents";
import type { WorkflowProgress, WorkflowAgentCompletion } from "../shared/workflow-agents";
import type { Usage } from "@earendil-works/pi-ai";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { makeWorker, syncModelAccess } from "./runtime";
import { message, MESSAGE_KEY, text } from "./messages";
import { validName, normalizeTemplate } from "./templates";
import type { AgentRecord, AgentGroup, AgentOwnership, WorkflowRegistry, Config, Envelope, Identity, Member, Selection, Status, Template } from "./types";

const DEADLOCK = "Everyone else is waiting or idle. Message an agent or keep working.";
interface OwnedRun { record: AgentRecord; runId: string; baseline: number; task: OwnedTask; usage?: Usage }
interface OwnedTask {
  record: AgentRecord; taskRunId?: string; scopeSignal: AbortSignal; signal: AbortSignal; abort: () => void;
  runs: Map<string, OwnedRun>; usage: Usage; cancelled: boolean; cancelling?: Promise<void>;
}
export interface WorkspaceOptions {
  cwd: string; agentDir: string; trusted: boolean; config: Config; templates: Map<string, Template>;
  identity: Identity; context: ExtensionContext; global?: Selection;
  append: (key: string, data: unknown) => void;
  rootSend: (envelope: Envelope, start: boolean) => void;
  workerFactory?: typeof makeWorker;
  ephemeralSessions?: Map<string, SessionManager>;
}
export class Workspace {
  readonly records = new Map<string, AgentRecord>();
  readonly groups = new Map<string, AgentGroup>();
  readonly rootGroupId: string;
  readonly workflowProgress = new Map<string, WorkflowProgress>();
  private nameCounters = new Map<string, number>();
  private reservedNames = new Set<string>();
  private reservations = 0;
  private acquisitions: {signal: AbortSignal; resolve: () => void; reject: (error: Error) => void; abort: () => void}[] = [];
  private hostAwaiting = new Map<string, number>();
  private ownedTasks = new Map<string, Set<OwnedTask>>();
  private ownedRuns = new WeakMap<AgentRecord, Map<string, OwnedRun>>();
  private rootTasks = new WeakMap<AgentRecord, OwnedTask>();
  private preparingTasks = new WeakMap<AgentRecord, OwnedTask>();
  private completions = new Map<string, {runId?: string; baseline: number; finalAssistant?: Extract<AgentMessage, {role: "assistant"}>; resolve: (result: WorkflowAgentCompletion) => void; reject: (error: Error) => void}>();
  readonly cwd: string; readonly agentDir: string; readonly trusted: boolean; readonly config: Config;
  readonly storage: string; readonly templates: Map<string, Template>;
  global?: Selection;
  readonly ephemeralSessions: Map<string, SessionManager>;
  closed = false;
  private listeners = new Set<() => void>();
  private emitted = new Set<string>();
  private waitSequence = 0;
  private disposals = new WeakMap<object, Promise<void>>();
  private setups = new Set<Promise<void>>();
  private recordSetups = new WeakMap<AgentRecord, Promise<void>>();
  readonly signal = new AbortController();
  private async setup(record: AgentRecord): Promise<void> {
    const promise = (this.options.workerFactory ?? makeWorker)(this, record, this.options.context);
    this.setups.add(promise); this.recordSetups.set(record, promise);
    try { await promise; } finally { this.setups.delete(promise); this.recordSetups.delete(record); }
  }
  private async disposeWorker(record: AgentRecord): Promise<void> {
    record.unsubscribe?.();
    if (!record.session) return;
    const session = record.session;
    let disposal = this.disposals.get(session);
    if (!disposal) {
      disposal = (async () => {
        await session.abort();
        try { await session.extensionRunner.emit({type: "session_shutdown", reason: "quit"}); }
        finally { session.dispose(); }
      })();
      this.disposals.set(session, disposal);
    }
    await disposal;
  }
  constructor(readonly options: WorkspaceOptions) {
    this.cwd = options.cwd; this.agentDir = options.agentDir; this.trusted = options.trusted;
    this.config = options.config; this.templates = options.templates; this.global = options.global;
    this.ephemeralSessions = options.ephemeralSessions ?? new Map();
    if (options.identity.version !== 1 || options.identity.name !== "main" || options.identity.role !== "interactive" || options.identity.parentName !== null || !/^[a-zA-Z0-9_-]{1,80}$/.test(options.identity.workspaceId)) throw new Error("Invalid workspace identity");
    this.storage = resolve(options.context.sessionManager.getSessionDir(), "subagents", options.identity.workspaceId);
    this.rootGroupId = options.identity.groupId ?? "root-" + options.identity.workspaceId;
    options.identity.groupId = this.rootGroupId;
    const groupEntries = workspaceData<AgentGroup>(options.context.sessionManager, GROUP_KEY, options.identity.workspaceId);
    for (const raw of groupEntries) { const group = normalizeGroup(raw); this.groups.set(group.id, group); if (group.agentName) this.reservedNames.add(group.agentName); }
    if (groupEntries.length) {
      validateGroups(this.groups, this.rootGroupId);
      if (this.group(this.rootGroupId).rootAgentInstanceId !== options.identity.instanceId) throw new Error("Root group identity mismatch");
    } else this.addGroup({version: 1, id: this.rootGroupId, parentGroupId: null, kind: "root", label: "Root group", rootAgentInstanceId: options.identity.instanceId});
    const template = this.template(options.identity.template);
    this.records.set("main", {identity: options.identity, template, ownership: {creationDepth: 0, depthScope: "group"}, status: options.context.isIdle() ? "idle" : "running", context: options.context,
      selection: options.context.model ? {model: options.context.model, thinking: options.context.thinkingLevel ?? "medium"} : undefined,
      messages: options.context.sessionManager.buildSessionProjection().messages, inbox: [], pending: []});
  }
  agentGroupId(identity: Identity): string { return identity.groupId ?? this.rootGroupId; }
  group(id: string): AgentGroup { const group = this.groups.get(id); if (!group) throw new Error("Unknown agent group"); return group; }
  members(groupId: string): AgentRecord[] { return [...this.records.values()].filter(r => this.agentGroupId(r.identity) === groupId); }
  addGroup(group: AgentGroup): AgentGroup {
    if (this.closed) throw new Error("Workspace is closed");
    const normalized = normalizeGroup(group);
    if (this.groups.has(group.id)) throw new Error("Agent group already exists");
    if (group.parentGroupId !== null) {
      const parent = this.group(group.parentGroupId);
      if (group.kind === "agents" && parent.kind !== "workflow" || group.kind === "workflow" && parent.kind === "workflow") throw new Error("Invalid agent group parent");
    }
    if (group.kind === "agents" && this.groupDepth(group.parentGroupId!) + 1 > this.config.max_group_depth) throw new Error("Maximum agent group nesting depth reached");
    this.groups.set(group.id, normalized); this.options.append(GROUP_KEY, normalized); this.changed(); return normalized;
  }
  updateGroup(id: string, update: Partial<Pick<AgentGroup, "rootAgentInstanceId" | "status" | "error">>): void {
    const group = normalizeGroup({...this.group(id), ...update}); this.groups.set(id, group);
    if (!this.closed) this.options.append(GROUP_KEY, group); this.changed();
  }
  resolveTemplate(parent: AgentRecord, name: string): Template { return parent.workflowRegistry?.templates.get(name) ?? this.template(name); }
  private communications(record: AgentRecord): void {
    if (isGroupRoot(record.identity) && !record.template.subagents.allowed.length) throw new Error("Workspace tools are unavailable to a leaf group root");
  }
  private localTarget(from: AgentRecord, name: string): AgentRecord {
    const target = this.records.get(name);
    if (!target || this.agentGroupId(from.identity) !== this.agentGroupId(target.identity)) throw new Error("Agent is not available in your group");
    return target;
  }
  private validEnvelope(record: AgentRecord, envelope: Envelope): boolean {
    const sender = this.records.get(envelope.from);
    return envelope.to === record.identity.name && !!sender && this.agentGroupId(sender.identity) === this.agentGroupId(record.identity);
  }
  template(name: string): Template {
    const template = this.templates.get(name);
    if (!template) throw new Error("Unknown/invalid template: " + name);
    return template;
  }
  get(name: string): AgentRecord {
    const record = this.records.get(name);
    if (!record) throw new Error("Unknown agent: " + name);
    if (this.closed) throw new Error("Workspace is closed");
    return record;
  }
  subscribe(listener: () => void): () => void { this.listeners.add(listener); return () => this.listeners.delete(listener); }
  changed(): void { for (const listener of this.listeners) listener(); }
  checkpoint(record: AgentRecord): void {
    const data = {name: record.identity.name, status: record.status, runId: record.runId, error: record.error};
    this.options.append(STATE_KEY, data);
    record.manager?.appendCustomEntry(STATE_KEY, data);
    this.changed();
  }
  async restore(): Promise<void> {
    // Historical orchestration never resumes automatically. Normalize display state only;
    // appending here could resurrect abandoned groups on a newly selected branch.
    for (const [id, group] of this.groups) if (id !== this.rootGroupId && (group.status === "queued" || group.status === "running")) {
      this.groups.set(id, {...group, status: "cancelled", error: group.error ?? "Interrupted; workflow execution is not resumed after restore."});
    }
    const registries = new Map<string, WorkflowRegistry>();
    for (const raw of workspaceData<unknown>(this.options.context.sessionManager, REGISTRY_KEY, this.options.identity.workspaceId)) {
      const registry = restoreRegistry(raw);
      const old = registries.get(registry.snapshot.id);
      if (old && JSON.stringify(old.snapshot) !== JSON.stringify(registry.snapshot)) throw new Error("Conflicting workflow registry snapshots");
      registries.set(registry.snapshot.id, registry);
    }
    const members = workspaceData<Member>(this.options.context.sessionManager, MEMBER_KEY, this.options.identity.workspaceId);
    for (const member of members) {
      if (!member?.identity || member.identity.version !== 1 || member.identity.name === "main" || member.identity.role !== "worker" || (member.identity.parentName !== null && typeof member.identity.parentName !== "string")) throw new Error("Invalid worker membership identity");
      if (member.identity.workspaceId !== this.options.identity.workspaceId) throw new Error("Worker membership belongs to another workspace");
      if (this.records.has(member.identity.name)) {
        const existing = this.records.get(member.identity.name)!;
        if (existing.identity.instanceId !== member.identity.instanceId) throw new Error("Conflicting agent membership identity");
        if (JSON.stringify(existing.ownership) !== JSON.stringify(member.ownership ? normalizeOwnership(member.ownership, 128) : undefined)) throw new Error("Conflicting worker ownership metadata");
        continue;
      }
      const identity = {...member.identity};
      const tagged = identity.groupId !== undefined;
      if (!tagged) {
        if (member.registryId || member.ownership || identity.parentName === null) throw new Error("Missing group metadata on isolated worker");
        identity.groupId = this.rootGroupId;
      }
      const group = this.group(identity.groupId!);
      if (group.kind === "workflow" || identity.role !== "worker" || (identity.parentName === null && group.rootAgentInstanceId !== identity.instanceId) || (identity.parentName !== null && group.rootAgentInstanceId === identity.instanceId)) throw new Error("Invalid group membership");
      if (tagged && !member.ownership) throw new Error("Missing worker ownership metadata");
      const ownership = member.ownership ? normalizeOwnership(member.ownership, 128) : undefined;
      if (identity.workflowRegistryId !== member.registryId) throw new Error("Missing or mismatched workflow provenance");
      const registry = member.registryId ? registries.get(member.registryId) : undefined;
      if (member.registryId && !registry) throw new Error("Missing workflow registry provenance");
      const savedTemplate = registry?.templates.get(identity.template);
      if (registry && (!savedTemplate || !registry.localNames.has(identity.template) || JSON.stringify(savedTemplate) !== JSON.stringify(member.template))) throw new Error("Workflow template provenance mismatch");
      const record: AgentRecord = {identity, ownership, workflowRegistry: registry, template: savedTemplate ?? normalizeTemplate(publicTemplate(member.template), member.template.source), status: "idle", sessionFile: member.sessionFile, messages: [], inbox: [], pending: []};
      try {
        validName(record.identity.name);
        record.manager = member.sessionFile ? SessionManager.open(workspaceFile(member.sessionFile, this.storage)) : this.ephemeralSessions.get(member.identity.instanceId);
        if (!record.manager) throw new Error("Ephemeral worker history is unavailable in this process");
        const identity = customData<Identity>(record.manager, IDENTITY_KEY).at(-1);
        if (identity?.instanceId !== record.identity.instanceId || identity.role !== "worker" || identity.workspaceId !== record.identity.workspaceId || identity.name !== record.identity.name || identity.parentName !== record.identity.parentName || (tagged && (identity.groupId !== record.identity.groupId || identity.workflowRegistryId !== record.identity.workflowRegistryId))) throw new Error("Worker identity mismatch");
        if (registry) {
          const saved = customData<unknown>(record.manager, REGISTRY_KEY).map(restoreRegistry).find(r => r.snapshot.id === registry.snapshot.id);
          if (!saved || JSON.stringify(saved.snapshot) !== JSON.stringify(registry.snapshot)) throw new Error("Worker workflow registry mismatch");
        }
        const projection = record.manager.buildSessionProjection();
        record.messages = projection.messages;
        const state = customData<{name?: string; status?: string; error?: unknown}>(record.manager, STATE_KEY).filter(s => s?.name === record.identity.name).at(-1);
        if (state?.status === "error" || state?.status === "interrupted") {
          record.status = state.status;
          if (typeof state.error === "string") record.error = state.error;
        }
        if (projection.model) {
          const model = this.options.context.modelRegistry.find(projection.model.provider, projection.model.modelId);
          if (model) record.selection = {model, thinking: projection.thinkingLevel as Selection["thinking"]};
        }
      } catch (e) { record.status = "error"; record.error = (e as Error).message; record.manager = undefined; }
      this.records.set(record.identity.name, record);
    }
    const instanceIds = new Set<string>();
    for (const record of this.records.values()) {
      if (instanceIds.has(record.identity.instanceId)) throw new Error("Duplicate agent instance identity");
      instanceIds.add(record.identity.instanceId);
      const parent = record.identity.parentName ? this.localTarget(record, record.identity.parentName) : undefined;
      if (record.identity.role === "worker" && record.ownership) {
        const owner = [...this.records.values()].find(r => r.identity.instanceId === record.ownership!.ownerInstanceId);
        if (!owner || owner === record || (parent && parent !== owner) || record.ownership.inheritanceSourceInstanceId !== owner.identity.instanceId) throw new Error("Invalid worker ownership lineage");
        if (!parent) {
          const container = this.group(this.group(this.agentGroupId(record.identity)).parentGroupId!);
          if (container.kind !== "workflow" || container.parentGroupId !== this.agentGroupId(owner.identity)) throw new Error("Invalid worker ownership lineage");
        }
        const legacyDepth = this.legacyDepth(record); // Also rejects cycles for new snapshots.
        const expected = record.ownership.depthScope === "group" ? this.depth(record) : legacyDepth;
        if (record.ownership.creationDepth !== expected) throw new Error("Invalid worker ownership lineage");
      }
      if (parent && this.depth(record) > 128) throw new Error("Invalid worker ancestry");
      if (record.identity.role === "worker" && record.messages.some(m => m.role === "custom" && m.customType === MESSAGE_KEY && !this.validEnvelope(record, m.details as Envelope))) throw new Error("Corrupt cross-group worker message history");
    }
    for (const group of this.groups.values()) {
      if (group.rootAgentInstanceId && this.members(group.id).filter(r => r.identity.instanceId === group.rootAgentInstanceId && r.identity.parentName === null).length !== 1) throw new Error("Missing or duplicate group root member");
    }
    // Migrate only in memory, after every old/new snapshot passed its own checks.
    // Never append membership entries or change the selected history branch.
    for (const record of this.records.values()) if (record.ownership && !record.ownership.depthScope) {
      record.ownership = {...record.ownership, creationDepth: this.depth(record), depthScope: "group"};
    }
    const deliveries = workspaceData<{envelope: Envelope; delivered?: boolean}>(this.options.context.sessionManager, DELIVERY_KEY, this.options.identity.workspaceId);
    const latest = new Map<string, {envelope: Envelope; delivered?: boolean}>();
    for (const entry of deliveries) if (entry?.envelope?.id) latest.set(entry.envelope.id, entry);
    for (const {envelope, delivered} of latest.values()) {
      this.emitted.add(envelope.id);
      const target = this.records.get(envelope.to);
      if (!target) continue;
      if (!this.validEnvelope(target, envelope)) throw new Error("Corrupt cross-group delivery envelope");
      if (delivered) continue;
      const inContext = target.messages.some(m => m.role === "custom" && m.customType === MESSAGE_KEY && (m.details as Envelope)?.id === envelope.id);
      if (inContext) this.options.append(DELIVERY_KEY, {envelope, delivered: true});
      else target.pending.push(envelope);
    }
  }
  list(name: string, all = false) {
    const caller = this.get(name); this.communications(caller);
    return this.members(this.agentGroupId(caller.identity)).filter(r => all || r.identity.parentName === name).map(r => ({
      name: r.identity.name, parent: r.identity.parentName, template: r.template.name, role: r.identity.role, status: r.status,
      ...(r.selection ? {model: r.selection.model.provider + "/" + r.selection.model.id, thinking: r.selection.thinking} : {}),
      ...(r.error ? {error: r.error} : {}),
    }));
  }
  private activeWorkers(): AgentRecord[] { return [...this.records.values()].filter(r => r.identity.role === "worker" && ["starting", "running", "waiting"].includes(r.status)); }
  private capacity(): void {
    if (this.activeWorkers().length + this.reservations >= this.config.max_running) throw new Error("Worker capacity reached (" + this.config.max_running + ")");
  }
  private pump(): void {
    if (this.closed) { for (const request of this.acquisitions.splice(0)) { request.signal.removeEventListener("abort", request.abort); request.reject(new Error("Workspace closed")); } return; }
    while (this.acquisitions.length && this.activeWorkers().length + this.reservations < this.config.max_running) {
      const request = this.acquisitions.shift()!; request.signal.removeEventListener("abort", request.abort);
      if (request.signal.aborted) { request.reject(new Error("Workflow agent cancelled while queued")); continue; }
      this.reservations++; request.resolve();
    }
    const active = this.activeWorkers();
    if (this.acquisitions.length && !this.reservations && active.length && active.every(r => this.hostAwaiting.has(r.identity.instanceId))) {
      for (const request of this.acquisitions.splice(0)) {
        request.signal.removeEventListener("abort", request.abort);
        request.reject(new Error("Workflow capacity deadlock: all worker slots are held by agents awaiting nested workflows. Increase max_running or reduce nesting/fan-out."));
      }
    }
  }
  private acquire(signal: AbortSignal): Promise<void> {
    signal.throwIfAborted();
    return new Promise((resolve, reject) => {
      const request = {signal, resolve, reject, abort: () => {
        const index = this.acquisitions.indexOf(request); if (index >= 0) this.acquisitions.splice(index, 1);
        reject(new Error("Workflow agent cancelled while queued")); this.pump();
      }};
      signal.addEventListener("abort", request.abort, {once: true}); this.acquisitions.push(request); this.pump();
    });
  }
  reserveWorkflowName(prefix: string): string {
    validName(prefix);
    let counter = this.nameCounters.get(prefix) ?? 0, name: string;
    do { const suffix = "-" + (++counter); name = prefix.slice(0, 64 - suffix.length) + suffix; } while (this.records.has(name) || this.reservedNames.has(name));
    this.nameCounters.set(prefix, counter); this.reservedNames.add(name); return name;
  }
  private groupDepth(id: string): number {
    let depth = 0;
    const visited = new Set<string>();
    for (;;) {
      if (visited.has(id)) throw new Error("Cyclic agent groups");
      visited.add(id);
      const group = this.group(id);
      if (group.kind === "agents") depth++;
      if (group.parentGroupId === null) {
        if (id !== this.rootGroupId || group.kind !== "root") throw new Error("Agent group is outside workspace");
        return depth;
      }
      id = group.parentGroupId;
    }
  }
  private depth(record: AgentRecord): number {
    let depth = 0, ancestor = record;
    const visited = new Set<string>();
    for (;;) {
      if (visited.has(ancestor.identity.instanceId)) throw new Error("Invalid cyclic parent relationship");
      visited.add(ancestor.identity.instanceId);
      if (ancestor.identity.parentName === null) return depth;
      ancestor = this.localTarget(ancestor, ancestor.identity.parentName);
      depth++;
    }
  }
  // Reconstruct the old cross-group depth from lineage, never from unvalidated
  // numeric metadata. Keep this separate from group-local nesting.
  private legacyDepth(record: AgentRecord): number {
    let depth = 0, ancestor = record;
    const visited = new Set<string>();
    while (ancestor.identity.role !== "interactive") {
      if (visited.has(ancestor.identity.instanceId)) throw new Error("Invalid cyclic ownership lineage");
      visited.add(ancestor.identity.instanceId);
      const owner = ancestor.ownership
        ? [...this.records.values()].find(r => r.identity.instanceId === ancestor.ownership!.ownerInstanceId)
        : ancestor.identity.parentName ? this.localTarget(ancestor, ancestor.identity.parentName) : undefined;
      if (!owner) throw new Error("Invalid worker ownership lineage");
      ancestor = owner; depth++;
    }
    return depth;
  }
  private ownership(parent: AgentRecord, ownerRunId = parent.runId, groupRoot = false): AgentOwnership {
    const creationDepth = groupRoot ? 0 : this.depth(parent) + 1;
    if (creationDepth > this.config.max_depth) throw new Error("Maximum agent nesting depth reached");
    return {ownerInstanceId: parent.identity.instanceId, ownerRunId, ownerTaskRunId: parent.runId, creationDepth, depthScope: "group", inheritanceSourceInstanceId: parent.identity.instanceId};
  }
  async cancelOwnedRun(runId: string): Promise<void> {
    const tasks = this.ownedTasks.get(runId);
    if (!tasks) return;
    await Promise.allSettled([...tasks].map(task => this.cancelTask(task)));
    for (const task of tasks) {
      this.refreshTaskUsage(task); task.signal.removeEventListener("abort", task.abort);
      this.rootTasks.delete(task.record);
      for (const run of task.runs.values()) this.ownedRuns.get(run.record)?.delete(run.runId);
    }
    this.ownedTasks.delete(runId);
  }
  async cancelWorkflowScope(runId: string, signal: AbortSignal): Promise<void> {
    const tasks = this.ownedTasks.get(runId);
    if (tasks) await Promise.allSettled([...tasks].filter(task => task.scopeSignal === signal).map(task => this.cancelTask(task)));
  }
  private cancelTask(task: OwnedTask): Promise<void> {
    task.cancelled = true;
    return task.cancelling ??= (async () => {
      await Promise.allSettled([...task.runs.values()].map(run => this.cancelTree(run.record, run.runId)));
      if (this.preparingTasks.get(task.record) === task) await this.cancelTree(task.record, task.record.runId);
      // A setup failure can precede issuance of the first run ID.
      if (!task.runs.size) await this.cancelTree(task.record, task.taskRunId);
      this.refreshTaskUsage(task);
    })();
  }
  private async cancelTree(record: AgentRecord, taskRunId = record.runId): Promise<void> {
    const active = (!taskRunId || record.runId === taskRunId) && ["starting", "running", "waiting"].includes(record.status);
    if (active) { record.cancelled = true; record.taskController?.abort(); }
    if (active) record.waiter?.finish(new Error("Workflow agent cancelled"));
    await Promise.allSettled([...this.records.values()].filter(r => r.ownership?.ownerInstanceId === record.identity.instanceId && (!taskRunId || (r.ownership.ownerTaskRunId ?? r.ownership.ownerRunId) === taskRunId)).map(r => {
      const rootTask = this.rootTasks.get(r); return rootTask ? this.cancelTask(rootTask) : this.cancelTree(r);
    }));
    if (active) { await this.recordSetups.get(record)?.catch(() => {}); await record.session?.abort(); this.finishOwnedRun(record); }
    if (active && ["starting", "running", "waiting"].includes(record.status)) { record.status = "interrupted"; this.checkpoint(record); }
    if (active) this.rejectCompletion(record, new Error("Workflow agent cancelled")); this.pump();
  }
  private usage(record: AgentRecord, baseline: number, visited = new Set<string>(), includeChildren = true): Usage | undefined {
    if (visited.has(record.identity.instanceId)) return;
    visited.add(record.identity.instanceId);
    let total: Usage | undefined;
    const entries = record.manager?.getBranch().filter(entry => baseline === 0 || !record.usageEntryIds?.has(entry.id)) ?? [];
    const persisted = entries.flatMap(entry => {
      if (entry.type === "message" && "usage" in entry.message && entry.message.usage) return [entry.message.usage as Usage];
      if ("usage" in entry && entry.usage) return [entry.usage as Usage];
      return [];
    });
    const usages = persisted.length ? persisted : (record.session?.messages.slice(baseline) ?? record.messages.slice(baseline)).flatMap(message => "usage" in message && message.usage ? [message.usage as Usage] : []);
    for (const usage of usages) {
      if (!usage) continue;
      total ??= this.emptyUsage(); this.addUsage(total, usage);
    }
    // Ordinary descendants have no reporting tool usage of their own; nested workflow roots do,
    // so traverse only same-group ownership to avoid counting nested workflow results twice.
    for (const child of this.records.values()) if (includeChildren && child.ownership?.ownerInstanceId === record.identity.instanceId && this.agentGroupId(child.identity) === this.agentGroupId(record.identity)) {
      const usage = this.usage(child, 0, visited);
      if (!usage) continue;
      total ??= this.emptyUsage(); this.addUsage(total, usage);
    }
    return total;
  }
  private emptyUsage(): Usage { return {input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: {input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0}}; }
  private addUsage(total: Usage, usage?: Usage): void {
    if (!usage) return;
    for (const key of ["input", "output", "cacheRead", "cacheWrite", "totalTokens"] as const) total[key] += usage[key] ?? 0;
    for (const key of ["reasoning", "cacheWrite1h"] as const) if (usage[key] !== undefined) total[key] = (total[key] ?? 0) + usage[key]!;
    for (const key of ["input", "output", "cacheRead", "cacheWrite", "total"] as const) total.cost[key] += usage.cost?.[key] ?? 0;
  }
  private completionUsage(record: AgentRecord, baseline: number): Usage {
    const task = this.rootTasks.get(record);
    if (task) { this.refreshTaskUsage(task); return task.usage; }
    const usage = this.emptyUsage(); this.addUsage(usage, this.usage(record, baseline, new Set(), false)); return usage;
  }
  private refreshTaskUsage(task: OwnedTask): void {
    // Same-group continuations are separate, explicitly attributed runs. Nested
    // workflow roots have their own task, already accounted in the parent tool result.
    const total = this.emptyUsage();
    for (const run of task.runs.values()) this.addUsage(total, run.usage ?? (run.record.runId === run.runId ? this.usage(run.record, run.baseline, new Set(), false) : undefined));
    Object.assign(task.usage, total);
  }
  private finishOwnedRun(record: AgentRecord): void {
    if (!record.runId) return;
    const run = this.ownedRuns.get(record)?.get(record.runId);
    if (run && !run.usage) { run.usage = this.usage(record, run.baseline, new Set(), false) ?? this.emptyUsage(); this.refreshTaskUsage(run.task); }
  }
  private trackOwnedRun(record: AgentRecord, task?: OwnedTask): void {
    task ??= this.preparingTasks.get(record);
    if (!task && record.identity.parentName) {
      const parent = this.records.get(record.identity.parentName);
      task = parent?.runId ? this.ownedRuns.get(parent)?.get(parent.runId)?.task : undefined;
    }
    if (!task || !record.runId) return;
    if (task.cancelled || task.signal.aborted) throw new Error("Workflow task scope is cancelled");
    const run: OwnedRun = {record, task, runId: record.runId, baseline: record.session?.messages.length ?? 0};
    task.runs.set(record.identity.instanceId + ":" + record.runId, run);
    const runs = this.ownedRuns.get(record) ?? new Map(); runs.set(record.runId, run); this.ownedRuns.set(record, runs);
  }
  private messageTask(record: AgentRecord, envelopes: Envelope[]): OwnedTask | undefined {
    for (const envelope of envelopes) {
      const sender = this.records.get(envelope.from);
      if (!sender) continue;
      // Completion IDs bind to the sending run, even if the sender has resumed meanwhile.
      const prefix = "completion:" + sender.identity.instanceId + ":";
      const senderRunId = envelope.id.startsWith(prefix) ? envelope.id.slice(prefix.length) : sender.runId;
      const task = (senderRunId ? this.ownedRuns.get(sender)?.get(senderRunId)?.task : undefined) ?? this.preparingTasks.get(sender);
      if (task && (record === task.record || record.identity.groupId === task.record.identity.groupId)) return task;
    }
    return undefined;
  }
  private rejectCompletion(record: AgentRecord, cause: Error): void {
    const completion = this.completions.get(record.identity.instanceId);
    if (!completion) return;
    this.completions.delete(record.identity.instanceId);
    const error = Object.assign(new Error("Agent " + record.identity.name + " (" + record.template.name + ") failed: " + cause.message), {usage: this.completionUsage(record, completion.baseline)});
    completion.reject(error);
  }
  async launchWorkflow(callerName: string, name: string, task: string, template: Template, groupId: string, runId: string, registry: WorkflowRegistry | undefined, signals: AbortSignal[], onStarted?: () => void): Promise<WorkflowAgentCompletion> {
    const caller = this.get(callerName);
    const signal = AbortSignal.any([this.signal.signal, ...signals]);
    const ownerId = caller.identity.instanceId;
    this.hostAwaiting.set(ownerId, (this.hostAwaiting.get(ownerId) ?? 0) + 1);
    let acquired = false, record: AgentRecord | undefined;
    let ownedTask: OwnedTask | undefined;
    try {
      const validateLaunchGroup = () => {
        const group = this.group(groupId);
        const container = group.parentGroupId ? this.group(group.parentGroupId) : undefined;
        if (group.kind !== "agents" || (group.rootAgentInstanceId !== null && group.rootAgentInstanceId !== record?.identity.instanceId) || container?.kind !== "workflow" || container.parentGroupId !== this.agentGroupId(caller.identity)) throw new Error("Invalid workflow agent group ownership");
        if (this.groupDepth(groupId) > this.config.max_group_depth) throw new Error("Maximum agent group nesting depth reached");
      };
      text(task, "task"); const ownership = this.ownership(caller, runId, true);
      validateLaunchGroup();
      await this.acquire(signal); acquired = true;
      signal.throwIfAborted(); validateLaunchGroup();
      const identity: Identity = {version: 1, workspaceId: this.options.identity.workspaceId, instanceId: randomUUID(), name, template: template.name, role: "worker", parentName: null, groupId, rootSessionFile: this.options.identity.rootSessionFile};
      if (registry) identity.workflowRegistryId = registry.snapshot.id;
      if (this.records.has(name)) throw new Error("Agent name is already used: " + name);
      record = {identity, template, ownership, workflowRegistry: registry, status: "starting", messages: [], inbox: [], pending: []};
      this.records.set(name, record); this.reservations--; acquired = false;
      this.updateGroup(groupId, {rootAgentInstanceId: identity.instanceId, status: "running"});
      const result = new Promise<WorkflowAgentCompletion>((resolve, reject) => this.completions.set(identity.instanceId, {baseline: 0, resolve, reject}));
      // Observe rejection immediately, including cancellation during asynchronous setup.
      void result.catch(() => {});
      ownedTask = {record, signal, scopeSignal: signals.at(-1)!, runs: new Map(), usage: this.emptyUsage(), cancelled: false, abort: () => { void this.cancelTask(ownedTask!).catch(error => this.rejectCompletion(record!, error as Error)); }};
      this.rootTasks.set(record, ownedTask);
      const tasks = this.ownedTasks.get(runId) ?? new Set(); tasks.add(ownedTask); this.ownedTasks.set(runId, tasks);
      signal.addEventListener("abort", ownedTask.abort, {once: true});
      try {
        await this.initialize(record, caller);
        validateLaunchGroup();
        signal.throwIfAborted(); if (record.cancelled || this.closed) throw new Error("Workflow agent cancelled during startup");
        this.start(record, () => record!.session!.prompt(task, {expandPromptTemplates: false, source: "extension"}), ownedTask);
        ownedTask.taskRunId = record.runId; onStarted?.();
      } catch (e) {
        await this.disposeWorker(record); record.status = signal.aborted ? "interrupted" : "error"; record.error = (e as Error).message; this.checkpoint(record);
        this.rejectCompletion(record, e as Error); this.pump();
      }
      return await result;
    } catch (e) {
      this.updateGroup(groupId, {status: signal.aborted ? "cancelled" : "failed", error: (e as Error).message});
      if (record) throw e;
      throw new Error("Agent " + name + " (" + template.name + ") failed: " + (e as Error).message);
    } finally {
      // Retain the task ownership listener after successful/failed completion until run.close.
      // Branch cancellation may arrive while its callback is doing subsequent tool work.
      if (!record && ownedTask) signal.removeEventListener("abort", ownedTask.abort);
      if (acquired) this.reservations--;
      const count = (this.hostAwaiting.get(ownerId) ?? 1) - 1;
      if (count) this.hostAwaiting.set(ownerId, count); else this.hostAwaiting.delete(ownerId);
      this.pump(); this.deadlock();
    }
  }
  private async initialize(record: AgentRecord, parent: AgentRecord, validate?: () => void): Promise<void> {
    record.manager = this.options.context.sessionManager.getSessionFile() ? SessionManager.create(this.cwd, this.storage) : SessionManager.inMemory(this.cwd);
    if (!record.manager.getSessionFile()) this.ephemeralSessions.set(record.identity.instanceId, record.manager);
    if (record.workflowRegistry) {
      this.options.append(REGISTRY_KEY, record.workflowRegistry.snapshot);
      record.manager.appendCustomEntry(REGISTRY_KEY, record.workflowRegistry.snapshot);
    }
    record.manager.appendCustomEntry(GROUP_KEY, this.group(this.agentGroupId(record.identity)));
    record.manager.appendCustomEntry(IDENTITY_KEY, record.identity);
    record.manager.appendMessage({role: "user", content: "Workspace initialized for " + record.identity.name + ". Parent: " + (record.identity.parentName ?? "none (non-interactive group root)") + ". Await your assigned task.", timestamp: Date.now()});
    record.sessionFile = record.manager.getSessionFile();
    const member: Member = {identity: record.identity, template: record.template, sessionFile: record.sessionFile, ownership: record.ownership, ...(record.workflowRegistry ? {registryId: record.workflowRegistry.snapshot.id} : {})};
    const persistMember = () => {
      this.options.append(MEMBER_KEY, member); parent.manager?.appendCustomEntry(MEMBER_KEY, member);
      record.manager!.appendCustomEntry(MEMBER_KEY, member);
    };
    // Workflow reservations remain inspectable even on setup failure; ordinary creates retain rollback semantics.
    if (record.identity.parentName === null) persistMember();
    record.selection = selection(record.template, parent.selection, this.global, this.options.context);
    record.taskController = new AbortController();
    await this.setup(record);
    validate?.();
    if (record.identity.parentName !== null && !this.closed && !record.cancelled) persistMember();
  }
  async create(parentName: string, name: string, task: string, templateName?: string | null, signal?: AbortSignal): Promise<void> {
    const parent = this.get(parentName);
    if (parent.cancelled) throw new Error("Parent task is cancelled");
    validName(name); text(task, "task");
    if (this.records.has(name) || this.reservedNames.has(name)) throw new Error("Agent name is already used: " + name);
    const child = templateName ?? parent.template.subagents.default;
    if (!child) throw new Error("No default subagent; specify agent_template");
    if (!parent.template.subagents.allowed.includes(child)) throw new Error("Child template is not permitted: " + child);
    const template = this.resolveTemplate(parent, child);
    const validateCreation = () => {
      if (this.depth(parent) + 1 > this.config.max_depth) throw new Error("Maximum agent nesting depth reached");
      if (this.groupDepth(this.agentGroupId(parent.identity)) > this.config.max_group_depth) throw new Error("Maximum agent group nesting depth reached");
    };
    validateCreation();
    const ownership = this.ownership(parent);
    this.capacity(); signal?.throwIfAborted();
    const identity: Identity = {version: 1, workspaceId: this.options.identity.workspaceId, instanceId: randomUUID(), name,
      template: template.name, role: "worker", parentName, groupId: this.agentGroupId(parent.identity), rootSessionFile: this.options.identity.rootSessionFile};
    const record: AgentRecord = {identity, template, ownership, workflowRegistry: parent.workflowRegistry?.localNames.has(child) ? parent.workflowRegistry : undefined, status: "starting", messages: [], inbox: [], pending: []};
    if (record.workflowRegistry) identity.workflowRegistryId = record.workflowRegistry.snapshot.id;
    // Reservation is synchronous before the first await.
    this.records.set(name, record); this.changed();
    try {
      await this.initialize(record, parent, validateCreation);
      signal?.throwIfAborted(); if (this.closed || record.cancelled) throw new Error("Workspace closed or task cancelled during startup");
      this.start(record, () => record.session!.prompt(task, {expandPromptTemplates: false, source: "extension"}));
    } catch (e) {
      await this.disposeWorker(record); this.records.delete(name); this.changed(); this.pump(); this.deadlock(); throw e;
    }
  }
  private start(record: AgentRecord, run: () => Promise<void>, ownerTask?: OwnedTask): void {
    record.status = "running"; record.error = undefined; record.cancelled = false; record.runId = randomUUID();
    record.usageEntryIds = new Set(record.manager?.getBranch().map(entry => entry.id));
    this.trackOwnedRun(record, ownerTask);
    const completion = this.completions.get(record.identity.instanceId);
    if (completion) { completion.runId = record.runId; completion.baseline = record.session?.messages.length ?? 0; }
    if (record.identity.parentName === null && this.agentGroupId(record.identity) !== this.rootGroupId) this.updateGroup(this.agentGroupId(record.identity), {status: "running", error: undefined});
    this.checkpoint(record);
    record.busy = Promise.resolve().then(() => {
      if (this.closed || record.cancelled) throw new Error("Agent task cancelled before prompt start");
      return run();
    }).catch(async e => {
      if (!this.closed) {
        record.status = "error"; record.error = (e as Error).message; this.checkpoint(record);
        if (this.completions.has(record.identity.instanceId)) {
          const descendants = [...this.records.values()].filter(r => r.ownership?.ownerInstanceId === record.identity.instanceId && (r.ownership.ownerTaskRunId ?? r.ownership.ownerRunId) === record.runId);
          await Promise.allSettled(descendants.map(r => this.cancelTree(r)));
        }
        this.finishOwnedRun(record); this.rejectCompletion(record, e as Error); this.report(record, "Agent failed: " + record.error);
      }
    }).finally(() => {
      record.busy = undefined;
      if (this.closed) return;
      if (record.status === "running") { record.status = "idle"; this.checkpoint(record); }
      // Messages received in the narrow settlement/resume window are drained after the run promise resolves.
      if (record.pending.length && record.wakeRequested) this.dispatchPending(record);
      for (const peer of this.records.values()) if (peer !== record && peer.wakeRequested && peer.pending.length && !peer.busy) this.dispatchPending(peer);
      this.pump(); this.deadlock();
    });
  }
  observe(record: AgentRecord, event: AgentSessionEvent): void {
    if (this.closed) return;
    if (event.type.startsWith("tool_execution_") && "toolCallId" in event) {
      record.toolUpdates ??= new Map();
      // Preserve start/update arguments when the final event omits them, so a
      // newly opened transcript can hydrate nested calls without preview loss.
      record.toolUpdates.set(event.toolCallId, {...record.toolUpdates.get(event.toolCallId), ...event});
    }
    if (event.type === "message_update" || event.type === "message_start" && event.message.role === "assistant") {
      record.messages = [...record.session!.messages.filter(m => m !== event.message), event.message];
    } else if (event.type === "message_end") {
      record.messages = [...record.session!.messages];
      const completion = this.completions.get(record.identity.instanceId);
      if (completion && completion.runId === record.runId && event.message.role === "assistant") completion.finalAssistant = event.message;
      if (event.message.role === "custom" && event.message.customType === MESSAGE_KEY) {
        const envelope = event.message.details as Envelope;
        if (!this.validEnvelope(record, envelope)) throw new Error("Corrupt cross-group delivery envelope");
        this.options.append(DELIVERY_KEY, {envelope, delivered: true});
      }
    } else if (event.type === "agent_settled") {
      record.status = event.aborted ? "interrupted" : "idle";
      const completion = this.completions.get(record.identity.instanceId);
      const runMessages = record.session!.messages.slice(completion?.baseline ?? 0);
      const last = completion?.finalAssistant ?? runMessages.filter(m => m.role === "assistant").at(-1);
      if (last?.role === "assistant" && last.stopReason === "error") { record.status = "error"; record.error = last.errorMessage; }
      this.finishOwnedRun(record); this.checkpoint(record);
      const final = last?.role === "assistant" ? last.content.filter(c => c.type === "text").map(c => c.text).join("\n") : "";
      if (completion && completion.runId === record.runId) {
        // Successful roots return at settlement; descendants remain owned by the issuing
        // scope until its closure. Failed tasks clean up descendants before rejection.
        const descendants = record.status === "idle" ? [] : [...this.records.values()].filter(r => r.ownership?.ownerInstanceId === record.identity.instanceId && (r.ownership.ownerTaskRunId ?? r.ownership.ownerRunId) === record.runId);
        const status = record.status, failure = record.error;
        void Promise.allSettled(descendants.map(r => this.cancelTree(r))).then(() => {
          if (this.completions.get(record.identity.instanceId) !== completion) return;
          if (status !== "idle") { this.rejectCompletion(record, new Error(failure ?? "Agent " + status)); return; }
          this.completions.delete(record.identity.instanceId);
          completion.resolve({name: record.identity.name, text: final, usage: this.completionUsage(record, completion.baseline)});
        });
      } else this.report(record, record.status === "idle" ? final || "Completed without a text answer." : "Agent " + record.status + (record.error ? ": " + record.error : "."));
      if (record.identity.parentName === null && this.agentGroupId(record.identity) !== this.rootGroupId) this.updateGroup(this.agentGroupId(record.identity), {status: record.status === "idle" ? "completed" : record.status === "interrupted" ? "cancelled" : "failed", ...(record.error ? {error: record.error} : {})});
      this.pump(); this.deadlock();
    }
    this.changed();
  }
  private report(record: AgentRecord, output: string): void {
    if (this.closed || record.cancelled || !record.identity.parentName) return;
    const id = "completion:" + record.identity.instanceId + ":" + record.runId;
    this.send(record.identity.name, record.identity.parentName, output.length > 30000 ? output.slice(0, 30000) + "\n[Report truncated; inspect worker session for full output.]" : output, id).catch(e => {
      if (!this.closed) { record.error = "Parent delivery failed: " + (e as Error).message; this.checkpoint(record); }
    });
  }
  async send(from: string, to: string, content: string, id: string = randomUUID()): Promise<string> {
    const sender = this.get(from); this.communications(sender);
    const target = this.localTarget(sender, to); text(content, "message");
    if (from === to) throw new Error("Self-messaging is not supported");
    if (this.emitted.has(id)) return id;
    const envelope: Envelope = {id, from, to, message: content};
    this.options.append(DELIVERY_KEY, {envelope, delivered: false}); this.emitted.add(id);
    target.wakeRequested = true; target.pending.push(envelope); this.dispatchPending(target);
    return id;
  }
  private dispatchPending(record: AgentRecord): void {
    if (this.closed || !record.pending.length || !record.wakeRequested) return;
    if (record.pending.some(envelope => !this.validEnvelope(record, envelope))) {
      record.pending = []; record.error = "Corrupt cross-group delivery envelope"; this.checkpoint(record); return;
    }
    const task = this.messageTask(record, record.pending);
    if (task && (task.cancelled || task.signal.aborted)) {
      record.wakeRequested = false; this.changed(); return;
    }
    if (record.identity.role === "interactive") {
      for (const envelope of record.pending.splice(0)) { const start = record.status === "idle"; record.status = record.waiter ? "waiting" : "running"; record.inbox.push(envelope); this.options.rootSend(envelope, start); }
      record.waiter?.finish(); this.changed(); return;
    }
    if (record.status === "starting") return;
    if (record.status === "running" || record.status === "waiting") {
      for (const envelope of record.pending.splice(0)) {
        record.inbox.push(envelope);
        record.session!.sendCustomMessage(message(envelope), {deliverAs: "steer", triggerTurn: true}).catch(e => { record.error = (e as Error).message; this.changed(); });
      }
      record.waiter?.finish(); this.changed(); return;
    }
    if (record.busy) return;
    try { this.capacity(); } catch (e) { record.error = (e as Error).message; this.changed(); return; }
    record.status = "starting"; record.runId = randomUUID();
    if (task) this.preparingTasks.set(record, task); else this.preparingTasks.delete(record);
    this.changed();
    const prepare = async () => {
      try {
        const currentTemplate = record.workflowRegistry?.templates.get(record.identity.template) ?? this.template(record.identity.template);
        if (JSON.stringify(currentTemplate) !== JSON.stringify(record.template)) {
          await this.disposeWorker(record); record.session = undefined; record.unsubscribe = undefined;
          record.template = currentTemplate; record.toolUpdates = undefined;
        }
        const inheritance = [...this.records.values()].find(r => r.identity.instanceId === record.ownership?.inheritanceSourceInstanceId);
        record.selection = selection(record.template, inheritance?.selection ?? this.records.get(record.identity.parentName!)?.selection, this.global, this.options.context);
        if (!record.session) {
          if (!record.manager) throw new Error(record.error ?? "Worker session unavailable");
          record.taskController = new AbortController();
          await this.setup(record);
        } else {
          await syncModelAccess(record.session.modelRuntime, record, this.options.context);
          await record.session.setModel(record.selection.model); record.session.setThinkingLevel(record.selection.thinking);
          record.selection = {model: record.session.model!, thinking: record.session.thinkingLevel};
        }
        if (this.closed) { await this.disposeWorker(record); return; }
        if (record.cancelled || task?.cancelled || task?.signal.aborted) throw new Error("Workflow task scope cancelled during resume setup");
        const envelopes = record.pending.splice(0); record.wakeRequested = false; record.inbox.push(...envelopes);
        // Batch recovered/rapid messages in one initial turn, retaining individual IDs for reconciliation.
        for (const envelope of envelopes.slice(0, -1)) await record.session!.sendCustomMessage(message(envelope), {triggerTurn: false});
        this.start(record, () => record.session!.sendCustomMessage(message(envelopes.at(-1)!), {deliverAs: "steer", triggerTurn: true}), task);
      } catch (e) { if (!this.closed) { record.status = record.cancelled || task?.cancelled || task?.signal.aborted ? "interrupted" : "error"; record.error = (e as Error).message; this.checkpoint(record); this.report(record, "Agent failed to resume: " + record.error); this.pump(); this.deadlock(); } }
      finally { if (this.preparingTasks.get(record) === task) this.preparingTasks.delete(record); }
    };
    void prepare();
  }
  async wait(name: string, timeout = 120, signal?: AbortSignal) {
    if (!Number.isFinite(timeout) || timeout <= 0 || timeout > 600) throw new Error("timeout must be >0 and <=600 seconds");
    const record = this.get(name); this.communications(record); signal?.throwIfAborted();
    if (record.inbox.some(envelope => !this.validEnvelope(record, envelope))) throw new Error("Corrupt cross-group inbox envelope");
    if (record.waiter) throw new Error("This agent is already waiting");
    const consume = () => ({status: "received", messages: record.inbox.splice(0).map(e => ({id: e.id, from: e.from}))});
    if (record.inbox.length) return consume();
    const previous = record.status; record.status = "waiting"; this.checkpoint(record);
    try {
      await new Promise<void>((resolveWait, reject) => {
        const finish = (error?: Error) => { clearTimeout(timer); signal?.removeEventListener("abort", abort); record.waiter = undefined; error ? reject(error) : resolveWait(); };
        const abort = () => finish(new Error("Message wait cancelled"));
        const timer = setTimeout(() => finish(), timeout * 1000);
        record.waiter = {finish, sequence: ++this.waitSequence}; signal?.addEventListener("abort", abort, {once: true});
        // Defer deadlock evaluation so a sibling parallel send/create call can establish progress.
        queueMicrotask(() => this.deadlock());
      });
      return record.inbox.length ? consume() : {status: "timeout", messages: []};
    } finally { if (!this.closed) { record.status = previous === "idle" ? "idle" : "running"; this.checkpoint(record); } }
  }
  deadlock(): void {
    if (this.closed) return;
    for (const group of this.groups.values()) {
      const members = this.members(group.id);
      if (members.some(r => ["running", "starting"].includes(r.status) || this.hostAwaiting.has(r.identity.instanceId))) continue;
      members.filter(r => r.waiter).sort((a, b) => a.waiter!.sequence - b.waiter!.sequence).at(-1)?.waiter?.finish(new Error(DEADLOCK));
    }
  }
  setMainStatus(status: Status, ctx?: ExtensionContext): void {
    const root = this.records.get("main")!;
    if (ctx) { root.context = ctx; if (ctx.model) root.selection = {model: ctx.model, thinking: ctx.thinkingLevel ?? "medium"}; }
    if (!root.waiter) root.status = status;
    this.changed(); this.deadlock();
  }
  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true; this.signal.abort(); this.pump();
    for (const record of this.records.values()) this.rejectCompletion(record, new Error("Workspace closed"));
    this.workflowProgress.clear();
    for (const record of this.records.values()) record.waiter?.finish(new Error("Workspace closed"));
    await Promise.allSettled([...this.setups]);
    await Promise.allSettled([...this.records.values()].map(async record => {
      if (!record.session) return;
      const active = ["starting", "running", "waiting"].includes(record.status);
      await this.disposeWorker(record); if (active) record.status = "interrupted";
      record.manager?.appendCustomEntry(STATE_KEY, {name: record.identity.name, status: record.status, runId: record.runId, error: record.error});
    }));
    this.listeners.clear();
  }
}
