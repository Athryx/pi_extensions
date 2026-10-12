import type { SessionManager } from "@earendil-works/pi-coding-agent";
export const IDENTITY_KEY = "subagents.identity.v1";
export function isWorkerSession(manager: Pick<SessionManager, "getBranch">): boolean {
  const identity = manager.getBranch().filter(e => e.type === "custom" && e.customType === IDENTITY_KEY).at(-1);
  return identity?.type === "custom" && (identity.data as {role?: string} | undefined)?.role === "worker";
}
