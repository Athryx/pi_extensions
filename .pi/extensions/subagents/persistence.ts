import { existsSync, realpathSync } from "node:fs";
import { resolve, relative, isAbsolute } from "node:path";
import type { SessionManager } from "@earendil-works/pi-coding-agent";
export const MEMBER_KEY = "subagents.member.v1", DELIVERY_KEY = "subagents.delivery.v1", STATE_KEY = "subagents.state.v1", TEMPLATE_KEY = "subagents.template.v1";
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
