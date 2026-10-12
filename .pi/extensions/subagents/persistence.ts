import { existsSync, realpathSync } from "node:fs";
import { resolve, relative, isAbsolute } from "node:path";
import type { SessionManager } from "@earendil-works/pi-coding-agent";
export const MEMBER_KEY = "subagents.member.v1", DELIVERY_KEY = "subagents.delivery.v1", STATE_KEY = "subagents.state.v1", TEMPLATE_KEY = "subagents.template.v1";
export const MAIN_TEMPLATE_LOCK_KEY = "subagents.main-template-lock.v1";
/** Session-wide, not branch-relative: rewinding the tree must not change agents. */
export function mainTemplateLock(manager: Pick<SessionManager, "getEntries">): string | undefined {
  const entry = manager.getEntries().filter(entry => entry.type === "custom" && entry.customType === MAIN_TEMPLATE_LOCK_KEY).at(-1);
  if (!entry || entry.type !== "custom") return;
  const data = entry.data as {version?: unknown; template?: unknown} | undefined;
  if (!data || data.version !== 1 || typeof data.template !== "string" || !data.template) throw new Error("Invalid persisted main agent template lock");
  return data.template;
}
export function hasUserMessage(manager: Pick<SessionManager, "getEntries">): boolean {
  return manager.getEntries().some(entry => entry.type === "message" && entry.message.role === "user");
}
export function customData<T>(manager: Pick<SessionManager, "getBranch">, key: string): T[] {
  return manager.getBranch().flatMap(e => e.type === "custom" && e.customType === key ? [e.data as T] : []);
}
export function workspaceFile(file: string, root: string): string {
  const path = resolve(file), base = resolve(root);
  const rel = relative(base, path);
  if (!rel || rel.startsWith("..") || isAbsolute(rel)) throw new Error("Worker file is outside workspace storage");
  if (!existsSync(path)) throw new Error("Worker session file is missing: " + path);
  const canonical = relative(realpathSync(base), realpathSync(path));
  if (canonical.startsWith("..") || isAbsolute(canonical)) throw new Error("Worker file symlink escapes workspace storage");
  return path;
}
