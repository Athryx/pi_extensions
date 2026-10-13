import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { Usage } from "@earendil-works/pi-ai";

export const WORKFLOW_AGENTS_REQUEST = "subagents:workflow-agents:request:v1";
export interface WorkflowAgentCompletion { name: string; text: string; usage?: Usage }
export interface WorkflowAgentState { name: string; groupId: string; status: "queued" | "running" }
export interface WorkflowProgress { id: string; owner: string; details: unknown }
export interface WorkflowAgentRun {
  readonly id: string;
  registerAgents(definitions: unknown[]): Promise<void>;
  agent(prompt: string, template: string, name: string | undefined, signal: AbortSignal,
    onUpdate?: (state: WorkflowAgentState) => void): Promise<WorkflowAgentCompletion>;
  updateProgress(details: unknown): void;
  /** Await descendant cleanup for this scoped signal, including already-settled roots. */
  cancelAgents?(signal: AbortSignal): Promise<void>;
  close(reason?: string): Promise<void>;
}
export interface WorkflowAgentsAPI {
  readonly version: 1;
  openRun(options: { sourcePath: string; signal: AbortSignal }): WorkflowAgentRun;
  getProgress(): readonly WorkflowProgress[];
  subscribeProgress(listener: () => void): () => void;
}
export interface WorkflowAgentsRequest { reply(api: WorkflowAgentsAPI): void }
/** Synchronous, session-local discovery. The provider binds the real caller, never script arguments. */
export function requestWorkflowAgentsAPI(pi: Pick<ExtensionAPI, "events">): WorkflowAgentsAPI | undefined {
  let api: WorkflowAgentsAPI | undefined;
  pi.events.emit(WORKFLOW_AGENTS_REQUEST, {reply(value: WorkflowAgentsAPI) {
    if (value?.version === 1 && typeof value.openRun === "function") api = value;
  }} satisfies WorkflowAgentsRequest);
  return api;
}
