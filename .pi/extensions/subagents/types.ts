import type { AgentSessionEvent, AgentSession, ExtensionContext, SessionManager, SettingsManager } from "@earendil-works/pi-coding-agent";
import type { AgentMessage, ThinkingLevel } from "@earendil-works/pi-agent-core";
import type { Api, Model } from "@earendil-works/pi-ai";
export interface Template {
  name: string;
  selectable: boolean;
  model: { name: string; thinking: string };
  tools: { include_defaults: boolean; extra: string[] };
  skills: { include_defaults: boolean; extra_paths: string[] };
  prompt: string;
  subagents: { include_defaults: boolean; extra: string[]; allowed: string[]; default?: string };
  source: string;
}
export interface Config { agent_paths: string[]; max_running: number; max_depth: number; worker_exclude_extensions: string[] }
export type ToolSnapshot = Extract<AgentSessionEvent, {type: "tool_execution_start" | "tool_execution_update" | "tool_execution_end"}>;
export type Status = "starting" | "running" | "waiting" | "idle" | "error" | "interrupted";
export interface Identity {
  version: 1; workspaceId: string; instanceId: string; name: string;
  template: string; role: "interactive" | "worker"; parentName: string | null; rootSessionFile?: string;
}
export interface Selection { model: Model<Api>; thinking: ThinkingLevel }
export interface Envelope { id: string; from: string; to: string; message: string }
export interface AgentRecord {
  identity: Identity; template: Template; status: Status; selection?: Selection;
  sessionFile?: string; session?: AgentSession; manager?: SessionManager;
  context?: ExtensionContext; settings?: SettingsManager; error?: string; runId?: string; unsubscribe?: () => void;
  messages: AgentMessage[]; inbox: Envelope[]; pending: Envelope[];
  toolUpdates?: Map<string, ToolSnapshot>;
  busy?: Promise<void>;
  wakeRequested?: boolean;
  waiter?: { sequence: number; finish: (error?: Error) => void };
}
export interface Member { identity: Identity; template: Template; sessionFile?: string }
