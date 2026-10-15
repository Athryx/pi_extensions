import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import { isMode, type Mode } from "./config.ts";

export const MODE_ENTRY = "server-side-compaction.mode.v1";
export const PORTABLE_ENTRY = "server-side-compaction.portable.v1";
/** Only the selected branch is accepted. Never scan the entire session archive. */
export function getMode(branch: readonly SessionEntry[]): Mode | undefined {
  for (let i = branch.length - 1; i >= 0; i--) {
    const entry = branch[i];
    if (entry.type !== "custom" || entry.customType !== MODE_ENTRY) continue;
    const data = entry.data as { mode?: unknown; reset?: unknown } | undefined;
    if (data?.reset === true || data?.mode === null) return undefined;
    if (isMode(data?.mode)) return data.mode;
    throw new Error("Invalid server compaction policy record; append /compaction reset on this branch.");
  }
  return undefined;
}
export const modeRecord = (mode?: Mode): { mode: Mode | null } => ({ mode: mode ?? null });
