import type { Usage } from "@earendil-works/pi-ai";
import type { WorkflowAgentRun } from "../shared/workflow-agents.ts";
import { Progress } from "./progress.ts";
import { addUsage, emptyUsage, label, record, string, type NodeStatus, type WorkflowDetails } from "./types.ts";
interface Scope { controller: AbortController; closed: boolean; detach: () => void }
export type ExternalCall = (name: string, args: unknown, signal: AbortSignal) => Promise<unknown>;
export class WorkflowRun {
  readonly progress: Progress;
  readonly usage = emptyUsage();
  private scopes = new Map<string, Scope>();
  private pending = new Map<Promise<unknown>, string>();
  private agentControls = new Map<AbortSignal, {scope:string;detach:()=>void}>();
  // The host refreshes these private usage handles after descendant cleanup.
  private agentUsage = new Map<string, {usage?:Usage}>();
  private abortListener: () => void;
  private closing?: Promise<void>;
  constructor(readonly host: WorkflowAgentRun, signal: AbortSignal, sourcePath: string,
    publish: (details: WorkflowDetails) => void,
    private tool: ExternalCall, private model: ExternalCall) {
    this.progress = new Progress(host.id, sourcePath, d=>{host.updateProgress(d);publish(d)});
    this.issue(this.progress.root, signal);
    this.abortListener = () => { void this.cancel(this.progress.root).catch(()=>{}); };
    signal.addEventListener("abort", this.abortListener, {once:true});
    this.detach = () => signal.removeEventListener("abort", this.abortListener);
  }
  private detach: () => void;
  private issue(id: string, parent: AbortSignal): void {
    const controller = new AbortController();
    const abort = () => controller.abort(parent.reason);
    parent.addEventListener("abort", abort, {once:true});
    if (parent.aborted) abort();
    this.scopes.set(id,{controller,closed:false,detach:()=>parent.removeEventListener("abort",abort)});
  }
  private scope(id: unknown): [string, Scope] {
    const key = string(id,"scope"), scope = this.scopes.get(key);
    if (!scope) throw new Error("Unknown workflow scope");
    if (scope.closed || scope.controller.signal.aborted) throw new Error("Workflow scope is closed or cancelled");
    return [key, scope];
  }
  private owned<T>(id: string, signal: AbortSignal, work: (signal: AbortSignal) => Promise<T>, retainAgent=false): Promise<T> {
    const scope = this.scopes.get(id)!;
    const controller = new AbortController();
    const abortScope = () => controller.abort(scope.controller.signal.reason);
    const abortCall = () => controller.abort(signal.reason);
    scope.controller.signal.addEventListener("abort",abortScope,{once:true});
    signal.addEventListener("abort",abortCall,{once:true});
    if (signal.aborted || scope.controller.signal.aborted) controller.abort();
    if(retainAgent)this.agentControls.set(controller.signal,{scope:id,detach:()=>scope.controller.signal.removeEventListener("abort",abortScope)});
    const promise = Promise.resolve().then(()=>{
      controller.signal.throwIfAborted(); return work(controller.signal);
    });
    this.pending.set(promise,id);
    void promise.finally(()=>{
      this.pending.delete(promise);
      if(!retainAgent)scope.controller.signal.removeEventListener("abort",abortScope);
      signal.removeEventListener("abort",abortCall);
    }).catch(()=>{});
    return promise;
  }
  async cancel(id: string): Promise<void> {
    const updates: Array<[string, {status:NodeStatus;endedAt:number}]>=[];
    for (const [key, scope] of this.scopes) if (this.progress.isBelow(key,id)) {
      scope.closed = true; scope.controller.abort(new Error("Workflow scope cancelled"));
      const node = this.progress.get(key);
      if (node.status === "pending" || node.status === "running" || node.status === "queued")
        updates.push([key,{status:node.status === "pending" ? "skipped" : "cancelled",endedAt:Date.now()}]);
    }
    this.progress.mutateMany(updates);
    const agents=[...this.agentControls].filter(([,control])=>this.progress.isBelow(control.scope,id));
    await Promise.allSettled([
      ...[...this.pending].filter(([,key])=>this.progress.isBelow(key,id)).map(([p])=>p),
      ...agents.map(([signal])=>this.host.cancelAgents?.(signal)),
    ]);
    for(const [signal,control] of agents){control.detach();this.agentControls.delete(signal);}
  }
  async dispatch(value: unknown, signal: AbortSignal): Promise<unknown> {
    const op = record(value,["op","scope","kind","label","count","status","prompt","template","name","definitions","args","failed_scope"]);
    const [id,scope] = this.scope(op.scope);
    switch(op.op) {
      case "create": {
        record(value,["op","scope","kind","label","count"]);
        if (op.kind !== "sequence" && op.kind !== "parallel") throw new Error("Invalid composition kind");
        if (typeof op.count !== "number" || !Number.isInteger(op.count) || op.count < 0 ||
            this.progress.size + op.count + 1 > 10000) throw new Error("Invalid or excessive composition size");
        const name = label(op.label,op.kind === "sequence" ? "Sequence" : "Parallel");
        const composition = this.progress.add(id,op.kind,name); this.issue(composition,scope.controller.signal);
        const children: string[] = [];
        for (let i=0;i<op.count;i++) {
          const child = this.progress.add(composition,op.kind === "sequence" ? "stage" : "branch",
            (op.kind === "sequence" ? "Stage " : "Branch ") + (i+1));
          this.issue(child,this.scopes.get(composition)!.controller.signal); children.push(child);
        }
        this.progress.mutate(composition,{status:"running",startedAt:Date.now()});
        return {id:composition,children};
      }
      case "start": {
        record(value,["op","scope"]);
        this.progress.mutate(id,{status:"running",startedAt:Date.now()});
        const node = this.progress.get(id);
        if (node.parent && this.progress.get(node.parent).kind === "sequence") {
          const parent = this.progress.get(node.parent);
          this.progress.mutate(parent.id,{activeStage:parent.children.indexOf(id)});
        }
        return;
      }
      case "status":
        record(value,["op","scope","label"]);
        this.progress.mutate(id,{label:label(string(op.label,"label"),"Working")}); return;
      case "finish": {
        record(value,["op","scope","status"]);
        if (op.status !== "completed" && op.status !== "failed") throw new Error("Invalid completion status");
        await this.cancel(id);
        this.progress.terminal(id,op.status);
        const node=this.progress.get(id);
        if (node.parent && node.kind === "stage" && op.status === "completed")
          this.progress.mutate(node.parent,{previousStage:this.progress.get(node.parent).children.indexOf(id)});
        return;
      }
      case "fail": {
        record(value,["op","scope","failed_scope"]);
        const child=string(op.failed_scope,"failed_scope");
        const node=this.progress.get(id);
        if(node.kind !== "parallel" || !node.children.includes(child)) throw new Error("Invalid failing branch scope");
        // One host operation aborts every sibling before any limiter continuation can start.
        await this.cancel(id);
        this.progress.terminal(child,"failed");
        this.progress.terminal(id,"failed"); return;
      }
      case "cancel":
        record(value,["op","scope"]); await this.cancel(id); return;
      case "register":
        record(value,["op","scope","definitions"]);
        if (!Array.isArray(op.definitions)) throw new Error("definitions must be an array");
        return this.owned(id,signal,async active=>{
          await this.host.registerAgents(op.definitions as unknown[]); active.throwIfAborted();
        });
      case "agent": {
        record(value,["op","scope","prompt","template","name"]);
        const prompt=string(op.prompt,"prompt"), template=string(op.template,"template");
        const name=op.name === undefined ? undefined : string(op.name,"name");
        const node=this.progress.add(id,"agent",label(template,"Agent"));
        this.issue(node,scope.controller.signal);
        this.progress.mutate(node,{status:"queued",startedAt:Date.now()});
        return this.owned(node,signal,async active=>{
          try {
            const completion=await this.host.agent(prompt,template,name,active,state=>{
              if (!active.aborted && !this.scopes.get(node)!.closed)
                this.progress.mutate(node,{agentName:state.name,groupId:state.groupId,status:state.status});
            });
            this.agentUsage.set(node,completion);
            active.throwIfAborted();
            this.progress.mutate(node,{agentName:completion.name});
            this.progress.terminal(node,"completed"); this.scopes.get(node)!.closed=true;
            return completion.text;
          } catch (error) {
            if(!this.agentUsage.has(node) && error && typeof error === "object")
              this.agentUsage.set(node,error as {usage?:Usage});
            this.progress.terminal(node,active.aborted ? "cancelled" : "failed");
            this.scopes.get(node)!.closed=true; throw error;
          }
        },true);
      }
      case "tool":
      case "model": {
        record(value,["op","scope","name","args"]);
        const name=string(op.name,"name");
        return this.owned(id,signal,active=>(op.op === "tool" ? this.tool : this.model)(name,op.args,active));
      }
      default: throw new Error("Unknown workflow operation");
    }
  }
  close(status: NodeStatus, reason?: string): Promise<void> {
    return this.closing ??= (async()=>{
      try {
        await this.cancel(this.progress.root);
        this.progress.terminal(this.progress.root,status);
      } finally {
        try { await this.host.close(reason); }
        finally {
          for(const handle of this.agentUsage.values())addUsage(this.usage,handle.usage);
          this.detach(); for (const scope of this.scopes.values()) scope.detach();
          for(const control of this.agentControls.values())control.detach();
          this.agentControls.clear();
        }
      }
    })();
  }
}
