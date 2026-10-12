import type { AgentSession, AgentSessionEvent, ExtensionAPI, SessionManager, SettingsManager } from "@earendil-works/pi-coding-agent";
import type { AgentMessage } from "@earendil-works/pi-agent-core";

export const VIEWED_SESSION_REQUEST = "ui:viewed-session:request:v1";
export const VIEWED_SESSION_CHANGED = "ui:viewed-session:changed:v1";
export type ViewedToolSnapshot = Extract<AgentSessionEvent, {type: "tool_execution_start" | "tool_execution_update" | "tool_execution_end"}>;
export interface ViewedSessionSnapshot {
  messages: readonly AgentMessage[];
  session?: AgentSession;
  manager?: SessionManager;
  settings?: SettingsManager;
  toolUpdates?: ReadonlyMap<string, ViewedToolSnapshot>;
}
/** A live source or stored history. Reading a snapshot must not start/resume an agent. */
export interface ViewedSessionSource {
  id: string;
  title: string;
  getSnapshot(): ViewedSessionSnapshot;
  subscribe(listener: () => void): () => void;
}
export interface ViewedSessionInfo { id: string; title: string }
export interface ViewedSessionAPI {
  readonly version: 1;
  readonly available: boolean;
  /** Display-only, always read-only. False means the native layout is unavailable. */
  setViewedSession(source: ViewedSessionSource | undefined): boolean;
  getViewedSession(): ViewedSessionInfo | undefined;
  onChange(listener: (view: ViewedSessionInfo | undefined) => void): () => void;
}
export interface ViewedSessionRequest { reply(api: ViewedSessionAPI): void }

/** Discovery is synchronous: providers reply before their event handler yields. Never cache across reloads. */
export function requestViewedSessionAPI(pi: Pick<ExtensionAPI, "events">): ViewedSessionAPI | undefined {
  let service: ViewedSessionAPI | undefined;
  pi.events.emit(VIEWED_SESSION_REQUEST, {reply(api: ViewedSessionAPI) {
    if (api?.version === 1 && typeof api.setViewedSession === "function"
      && typeof api.getViewedSession === "function" && typeof api.onChange === "function") service = api;
  }} satisfies ViewedSessionRequest);
  return service;
}
