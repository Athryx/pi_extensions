import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import type { AgentSessionEvent, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { IDENTITY_KEY } from "../shared/agent-role";
import { customData, MEMBER_KEY, DELIVERY_KEY, STATE_KEY, workspaceFile } from "./persistence";
import { selection } from "./loadout";
import { makeWorker, syncModelAccess } from "./runtime";
import { message, MESSAGE_KEY, text } from "./messages";
import { validName } from "./templates";
import type { AgentRecord, Config, Envelope, Identity, Member, Selection, Status, Template } from "./types";

const DEADLOCK = "Everyone else is waiting or idle. Message an agent or keep working.";
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
  readonly signal = new AbortController();
  private async setup(record: AgentRecord): Promise<void> {
    const promise = (this.options.workerFactory ?? makeWorker)(this, record, this.options.context);
    this.setups.add(promise);
    try { await promise; } finally { this.setups.delete(promise); }
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
    if (!/^[a-zA-Z0-9_-]{1,80}$/.test(options.identity.workspaceId)) throw new Error("Invalid workspace identity");
    this.storage = resolve(options.context.sessionManager.getSessionDir(), "subagents", options.identity.workspaceId);
    const template = this.template(options.identity.template);
    this.records.set("main", {identity: options.identity, template, status: options.context.isIdle() ? "idle" : "running", context: options.context,
      selection: options.context.model ? {model: options.context.model, thinking: options.context.thinkingLevel ?? "medium"} : undefined,
      messages: options.context.sessionManager.buildSessionProjection().messages, inbox: [], pending: []});
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
    const members = customData<Member>(this.options.context.sessionManager, MEMBER_KEY);
    for (const member of members) {
      if (!member?.identity || member.identity.workspaceId !== this.options.identity.workspaceId || member.identity.name === "main") continue;
      if (this.records.has(member.identity.name)) continue;
      const record: AgentRecord = {identity: member.identity, template: member.template, status: "idle", sessionFile: member.sessionFile, messages: [], inbox: [], pending: []};
      try {
        validName(record.identity.name);
        record.manager = member.sessionFile ? SessionManager.open(workspaceFile(member.sessionFile, this.storage)) : this.ephemeralSessions.get(member.identity.instanceId);
        if (!record.manager) throw new Error("Ephemeral worker history is unavailable in this process");
        const identity = customData<Identity>(record.manager, IDENTITY_KEY).at(-1);
        if (identity?.instanceId !== record.identity.instanceId || identity.role !== "worker") throw new Error("Worker identity mismatch");
        const projection = record.manager.buildSessionProjection();
        record.messages = projection.messages;
        if (projection.model) {
          const model = this.options.context.modelRegistry.find(projection.model.provider, projection.model.modelId);
          if (model) record.selection = {model, thinking: projection.thinkingLevel as Selection["thinking"]};
        }
      } catch (e) { record.status = "error"; record.error = (e as Error).message; record.manager = undefined; }
      this.records.set(record.identity.name, record);
    }
    const deliveries = customData<{envelope: Envelope; delivered?: boolean}>(this.options.context.sessionManager, DELIVERY_KEY);
    const latest = new Map<string, {envelope: Envelope; delivered?: boolean}>();
    for (const entry of deliveries) if (entry?.envelope?.id) latest.set(entry.envelope.id, entry);
    for (const {envelope, delivered} of latest.values()) {
      this.emitted.add(envelope.id);
      const target = this.records.get(envelope.to);
      if (!target || delivered) continue;
      const inContext = target.messages.some(m => m.role === "custom" && m.customType === MESSAGE_KEY && (m.details as Envelope)?.id === envelope.id);
      if (inContext) this.options.append(DELIVERY_KEY, {envelope, delivered: true});
      else target.pending.push(envelope);
    }
  }
  list(name: string, all = false) {
    return [...this.records.values()].filter(r => all || r.identity.parentName === name).map(r => ({
      name: r.identity.name, parent: r.identity.parentName, template: r.template.name, role: r.identity.role, status: r.status,
      ...(r.selection ? {model: r.selection.model.provider + "/" + r.selection.model.id, thinking: r.selection.thinking} : {}),
      ...(r.error ? {error: r.error} : {}),
    }));
  }
  private capacity(): void {
    if ([...this.records.values()].filter(r => r.identity.role === "worker" && ["starting", "running", "waiting"].includes(r.status)).length >= this.config.max_running) throw new Error("Worker capacity reached (" + this.config.max_running + ")");
  }
  async create(parentName: string, name: string, task: string, templateName?: string | null, signal?: AbortSignal): Promise<void> {
    const parent = this.get(parentName);
    validName(name); text(task, "task");
    if (this.records.has(name)) throw new Error("Agent name is already used: " + name);
    const child = templateName ?? parent.template.subagents.default;
    if (!child) throw new Error("No default subagent; specify agent_template");
    if (!parent.template.subagents.allowed.includes(child)) throw new Error("Child template is not permitted: " + child);
    const template = this.template(child);
    let depth = 1, ancestor = parent;
    const visited = new Set<string>();
    while (ancestor.identity.parentName) {
      if (visited.has(ancestor.identity.name)) throw new Error("Invalid cyclic parent relationship");
      visited.add(ancestor.identity.name); depth++; ancestor = this.get(ancestor.identity.parentName);
    }
    if (depth > this.config.max_depth) throw new Error("Maximum agent nesting depth reached");
    this.capacity(); signal?.throwIfAborted();
    const identity: Identity = {version: 1, workspaceId: this.options.identity.workspaceId, instanceId: randomUUID(), name,
      template: template.name, role: "worker", parentName, rootSessionFile: this.options.identity.rootSessionFile};
    const record: AgentRecord = {identity, template, status: "starting", messages: [], inbox: [], pending: []};
    // Reservation is synchronous before the first await.
    this.records.set(name, record); this.changed();
    try {
      record.selection = selection(template, parent.selection, this.global, this.options.context);
      record.manager = this.options.context.sessionManager.getSessionFile() ? SessionManager.create(this.cwd, this.storage) : SessionManager.inMemory(this.cwd);
      if (!record.manager.getSessionFile()) this.ephemeralSessions.set(identity.instanceId, record.manager);
      record.manager.appendCustomEntry(IDENTITY_KEY, identity);
      // Pi only flushes after a user/assistant message. This bootstrap persists identity before startup acknowledgment.
      record.manager.appendMessage({role: "user", content: "Workspace initialized for " + name + ". Parent: " + parentName + ". Await your assigned task.", timestamp: Date.now()});
      record.sessionFile = record.manager.getSessionFile();
      await this.setup(record);
      signal?.throwIfAborted(); if (this.closed) throw new Error("Workspace closed during startup");
      const member = {identity, template, sessionFile: record.sessionFile};
      this.options.append(MEMBER_KEY, member); parent.manager?.appendCustomEntry(MEMBER_KEY, member);
      this.start(record, () => record.session!.prompt(task, {expandPromptTemplates: false, source: "extension"}));
    } catch (e) {
      await this.disposeWorker(record); this.records.delete(name); this.changed(); this.deadlock(); throw e;
    }
  }
  private start(record: AgentRecord, run: () => Promise<void>): void {
    record.status = "running"; record.error = undefined; record.runId = randomUUID(); this.checkpoint(record);
    record.busy = Promise.resolve().then(run).catch(e => {
      if (!this.closed) { record.status = "error"; record.error = (e as Error).message; this.checkpoint(record); this.report(record, "Agent failed: " + record.error); }
    }).finally(() => {
      record.busy = undefined;
      if (this.closed) return;
      if (record.status === "running") { record.status = "idle"; this.checkpoint(record); }
      // Messages received in the narrow settlement/resume window are drained after the run promise resolves.
      if (record.pending.length && record.wakeRequested) this.dispatchPending(record);
      for (const peer of this.records.values()) if (peer !== record && peer.wakeRequested && peer.pending.length && !peer.busy) this.dispatchPending(peer);
      this.deadlock();
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
    if (event.type === "message_update") {
      record.messages = [...record.session!.messages.filter(m => m !== event.message), event.message];
    } else if (event.type === "message_end") {
      record.messages = [...record.session!.messages];
      if (event.message.role === "custom" && event.message.customType === MESSAGE_KEY) {
        const envelope = event.message.details as Envelope;
        this.options.append(DELIVERY_KEY, {envelope, delivered: true});
      }
    } else if (event.type === "agent_settled") {
      record.status = event.aborted ? "interrupted" : "idle";
      const last = record.session!.messages.filter(m => m.role === "assistant").at(-1);
      if (last?.role === "assistant" && last.stopReason === "error") { record.status = "error"; record.error = last.errorMessage; }
      this.checkpoint(record);
      const final = last?.role === "assistant" ? last.content.filter(c => c.type === "text").map(c => c.text).join("\n") : "";
      this.report(record, record.status === "idle" ? final || "Completed without a text answer." : "Agent " + record.status + (record.error ? ": " + record.error : "."));
      this.deadlock();
    }
    this.changed();
  }
  private report(record: AgentRecord, output: string): void {
    if (this.closed || !record.identity.parentName) return;
    const id = "completion:" + record.identity.instanceId + ":" + record.runId;
    this.send(record.identity.name, record.identity.parentName, output.length > 30000 ? output.slice(0, 30000) + "\n[Report truncated; inspect worker session for full output.]" : output, id).catch(e => {
      if (!this.closed) { record.error = "Parent delivery failed: " + (e as Error).message; this.checkpoint(record); }
    });
  }
  async send(from: string, to: string, content: string, id: string = randomUUID()): Promise<string> {
    this.get(from); const target = this.get(to); text(content, "message");
    if (from === to) throw new Error("Self-messaging is not supported");
    if (this.emitted.has(id)) return id;
    const envelope: Envelope = {id, from, to, message: content};
    this.options.append(DELIVERY_KEY, {envelope, delivered: false}); this.emitted.add(id);
    target.wakeRequested = true; target.pending.push(envelope); this.dispatchPending(target);
    return id;
  }
  private dispatchPending(record: AgentRecord): void {
    if (this.closed || !record.pending.length || !record.wakeRequested) return;
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
    record.status = "starting"; record.runId = randomUUID(); this.changed();
    const prepare = async () => {
      try {
        const currentTemplate = this.template(record.identity.template);
        if (JSON.stringify(currentTemplate) !== JSON.stringify(record.template)) {
          await this.disposeWorker(record); record.session = undefined; record.unsubscribe = undefined;
          record.template = currentTemplate; record.toolUpdates = undefined;
        }
        record.selection = selection(record.template, this.records.get(record.identity.parentName!)?.selection, this.global, this.options.context);
        if (!record.session) {
          if (!record.manager) throw new Error(record.error ?? "Worker session unavailable");
          await this.setup(record);
        } else {
          await syncModelAccess(record.session.modelRuntime, record, this.options.context);
          await record.session.setModel(record.selection.model); record.session.setThinkingLevel(record.selection.thinking);
          record.selection = {model: record.session.model!, thinking: record.session.thinkingLevel};
        }
        if (this.closed) { await this.disposeWorker(record); return; }
        const envelopes = record.pending.splice(0); record.wakeRequested = false; record.inbox.push(...envelopes);
        // Batch recovered/rapid messages in one initial turn, retaining individual IDs for reconciliation.
        for (const envelope of envelopes.slice(0, -1)) await record.session!.sendCustomMessage(message(envelope), {triggerTurn: false});
        this.start(record, () => record.session!.sendCustomMessage(message(envelopes.at(-1)!), {deliverAs: "steer", triggerTurn: true}));
      } catch (e) { if (!this.closed) { record.status = "error"; record.error = (e as Error).message; this.checkpoint(record); this.report(record, "Agent failed to resume: " + record.error); this.deadlock(); } }
    };
    void prepare();
  }
  async wait(name: string, timeout = 120, signal?: AbortSignal) {
    if (!Number.isFinite(timeout) || timeout <= 0 || timeout > 600) throw new Error("timeout must be >0 and <=600 seconds");
    const record = this.get(name); signal?.throwIfAborted();
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
    if (this.closed || [...this.records.values()].some(r => ["running", "starting"].includes(r.status))) return;
    [...this.records.values()].filter(r => r.waiter).sort((a, b) => a.waiter!.sequence - b.waiter!.sequence).at(-1)?.waiter?.finish(new Error(DEADLOCK));
  }
  setMainStatus(status: Status, ctx?: ExtensionContext): void {
    const root = this.records.get("main")!;
    if (ctx) { root.context = ctx; if (ctx.model) root.selection = {model: ctx.model, thinking: ctx.thinkingLevel ?? "medium"}; }
    if (!root.waiter) root.status = status;
    this.changed(); this.deadlock();
  }
  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true; this.signal.abort();
    for (const record of this.records.values()) record.waiter?.finish(new Error("Workspace closed"));
    await Promise.allSettled([...this.setups]);
    await Promise.allSettled([...this.records.values()].map(async record => {
      if (!record.session) return;
      await this.disposeWorker(record); record.status = "interrupted";
      record.manager?.appendCustomEntry(STATE_KEY, {name: record.identity.name, status: record.status, runId: record.runId});
    }));
    this.listeners.clear();
  }
}
