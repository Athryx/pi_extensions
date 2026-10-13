import type { AgentSessionEvent, AgentSession, ExtensionContext, SessionManager, SettingsManager } from "@earendil-works/pi-coding-agent";
import type { AgentMessage, ThinkingLevel } from "@earendil-works/pi-agent-core";
import type { Api, Model } from "@earendil-works/pi-ai";
export interface Template {
  name: string;
  description?: string;
  selectable: boolean;
  model: { name: string; thinking: string };
  tools: { include_defaults: boolean; extra: string[] };
  skills: { include_defaults: boolean; extra_paths: string[] };
  prompt: string;
  subagents: { include_defaults: boolean; extra: string[]; allowed: string[]; default?: string };
  source: string;
}
export interface Config { default_agent?: string; agent_paths: string[]; max_running: number; max_depth: number; max_group_depth: number; worker_exclude_extensions: string[] }
export type ToolSnapshot = Extract<AgentSessionEvent, {type: "tool_execution_start" | "tool_execution_update" | "tool_execution_end"}>;
export type Status = "starting" | "running" | "waiting" | "idle" | "error" | "interrupted";
export interface Identity {
  version: 1; workspaceId: string; instanceId: string; name: string;
  template: string; role: "interactive" | "worker"; parentName: string | null; rootSessionFile?: string; groupId?: string; workflowRegistryId?: string;
}
export interface Selection { model: Model<Api>; thinking: ThinkingLevel }
export interface Envelope { id: string; from: string; to: string; message: string }
export interface AgentRecord {
  identity: Identity; template: Template; status: Status; selection?: Selection;
  ownership?: AgentOwnership; workflowRegistry?: WorkflowRegistry; cancelled?: boolean; taskController?: AbortController;
  usageEntryIds?: Set<string>;
  sessionFile?: string; session?: AgentSession; manager?: SessionManager;
  context?: ExtensionContext; settings?: SettingsManager; error?: string; runId?: string; unsubscribe?: () => void;
  messages: AgentMessage[]; inbox: Envelope[]; pending: Envelope[];
  toolUpdates?: Map<string, ToolSnapshot>;
  busy?: Promise<void>;
  wakeRequested?: boolean;
  waiter?: { sequence: number; finish: (error?: Error) => void };
}
export interface AgentGroup {
  version: 1; id: string; parentGroupId: string | null; kind: "root" | "workflow" | "agents";
  label: string; rootAgentInstanceId: string | null; workflowRunId?: string; agentName?: string;
  status?: "queued" | "running" | "completed" | "failed" | "cancelled"; error?: string;
}
export interface AgentOwnership {
  // Marked snapshots store the agent's group-local depth (roots = 0).
  // Unmarked snapshots use legacy cross-group depth and are validated before migration.
  ownerInstanceId?: string; ownerRunId?: string; ownerTaskRunId?: string; creationDepth: number; depthScope?: "group"; inheritanceSourceInstanceId?: string;
}
export interface WorkflowRegistrySnapshot {
  version: 1; id: string; sourcePath: string; definitions: unknown[]; globals: unknown[];
}
export interface WorkflowRegistry { snapshot: WorkflowRegistrySnapshot; templates: Map<string, Template>; localNames: Set<string> }
export interface Member { identity: Identity; template: Template; sessionFile?: string; ownership?: AgentOwnership; registryId?: string }
