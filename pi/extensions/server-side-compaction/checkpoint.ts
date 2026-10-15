import { buildSessionProjection, type SessionEntry, type CompactionEntry, type SessionProjection, type CustomMessageEntry } from "@earendil-works/pi-coding-agent";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { Usage } from "@earendil-works/pi-ai";
import { validateOutput, getAdapter, type Compatibility } from "./openai.ts";
import { PORTABLE_ENTRY } from "./state.ts";

export interface ServerCheckpoint {
  kind: "server-side-compaction";
  version: 1;
  marker: string;
  compatibility: Compatibility;
  output: unknown[];
  source: {
    baseReadableCompactionId?: string;
    summarizedThroughEntryId: string;
    firstKeptEntryId: string;
  };
  readFiles: string[];
  modifiedFiles: string[];
}
export interface PortableCheckpoint { checkpointId: string; summary: string; usage?: Usage }
export interface ActiveCheckpoint {
  entry: CompactionEntry;
  data: ServerCheckpoint;
  portable?: PortableCheckpoint;
  portableEntry?: CustomMessageEntry;
}
const object = (value: unknown): Record<string, unknown> | undefined => value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
const text = (value: unknown): value is string => typeof value === "string" && value.trim().length > 0;
const invalid = (): never => { throw new Error("Encrypted checkpoint is invalid or its readable source history is missing. Restore its source branch before compacting or converting."); };
export const markerForCheckpoint = (id: string): string => `Server-side OpenAI checkpoint [${id}]`;
export function isServerCheckpointEntry(entry: SessionEntry): entry is CompactionEntry {
  return entry.type === "compaction" && (object(entry.details)?.kind === "server-side-compaction" || /^Server-side OpenAI checkpoint \[/.test(entry.summary));
}

/** Validate persisted ciphertext and anchors before allowing either replay or conversion. */
export function validateCheckpoint(entry: CompactionEntry, branch: readonly SessionEntry[]): ServerCheckpoint {
  const data = object(entry.details);
  if (!data || data.kind !== "server-side-compaction" || data.version !== 1 || !text(data.marker) || !entry.summary.includes(data.marker)) return invalid();
  const compatibility = object(data.compatibility);
  const source = object(data.source);
  if (!compatibility || !["provider", "api", "model", "endpoint", "accountFingerprint"].every(key => text(compatibility[key])) || !/^[a-f0-9]{64}$/.test(compatibility.accountFingerprint as string)) return invalid();
  const adapter = getAdapter({ provider: compatibility.provider as string, api: compatibility.api as string, id: compatibility.model as string, baseUrl: (compatibility.endpoint as string).replace(/\/compact$/, "") });
  if (!adapter || adapter.endpoint !== compatibility.endpoint) return invalid();
  if (!source || !text(source.firstKeptEntryId) || !text(source.summarizedThroughEntryId) || source.firstKeptEntryId !== entry.firstKeptEntryId) return invalid();
  const ownIndex = branch.findIndex(item => item.id === entry.id);
  const keptIndex = branch.findIndex(item => item.id === source.firstKeptEntryId);
  const throughIndex = branch.findIndex(item => item.id === source.summarizedThroughEntryId);
  if (ownIndex < 0 || keptIndex < 0 || throughIndex < 0 || throughIndex >= keptIndex || keptIndex >= ownIndex) return invalid();
  if (source.baseReadableCompactionId !== undefined) {
    if (!text(source.baseReadableCompactionId)) return invalid();
    const index = branch.findIndex(item => item.id === source.baseReadableCompactionId);
    const base = branch[index];
    if (index < 0 || index >= ownIndex || !base || base.type !== "compaction" || isServerCheckpointEntry(base)) return invalid();
  }
  for (const key of ["readFiles", "modifiedFiles"]) if (!Array.isArray(data[key]) || !(data[key] as unknown[]).every(value => typeof value === "string")) return invalid();
  try { validateOutput(data.output); } catch { return invalid(); }
  return data as unknown as ServerCheckpoint;
}

function portableRecord(entry: SessionEntry, checkpointId: string, branch: readonly SessionEntry[]): PortableCheckpoint | undefined {
  if (entry.type !== "custom_message" || entry.customType !== PORTABLE_ENTRY) return;
  const data = object(entry.details);
  if (data?.checkpointId !== checkpointId) return;
  if (!text(data.summary) || typeof entry.content !== "string" || entry.content !== data.summary || branch.some(candidate => candidate.type === "context_edit" && candidate.targetId === entry.id)) return invalid();
  return { checkpointId, summary: data.summary, ...(data.usage === undefined ? {} : { usage: data.usage as Usage }) };
}

/** Old encrypted entries under newer readable compactions are deliberately irrelevant. */
export function checkpoint(branch: readonly SessionEntry[]): ActiveCheckpoint | undefined {
  const projection = buildSessionProjection([...branch]);
  const visible = projection.entries.find(item => item.sourceEntry.type === "compaction" && item.messages.length > 0);
  if (!visible || !isServerCheckpointEntry(visible.sourceEntry)) return;
  const entry = visible.sourceEntry;
  const data = validateCheckpoint(entry, branch);
  let portable: PortableCheckpoint | undefined;
  let portableEntry: CustomMessageEntry | undefined;
  const ownIndex = branch.findIndex(item => item.id === entry.id);
  for (let i = branch.length - 1; i > ownIndex; i--) {
    const candidate = branch[i];
    if (candidate.type !== "custom_message" || candidate.customType !== PORTABLE_ENTRY || object(candidate.details)?.checkpointId !== entry.id) continue;
    portable = portableRecord(candidate, entry.id, branch);
    portableEntry = candidate;
    break;
  }
  return { entry, data, portable, portableEntry };
}
export const activeCheckpoint = checkpoint;

/**
 * Keep parent links while removing encrypted replacement semantics. Filtering the
 * entries themselves would sever the public projection's walk at each checkpoint.
 * Native readable compactions remain authoritative, as do append-only edits.
 */
export function reconstructReadableProjection(branch: readonly SessionEntry[]): SessionProjection {
  const active = checkpoint(branch);
  if (!active) return buildSessionProjection([...branch]);
  const activeIndex = branch.findIndex(item => item.id === active.entry.id);
  const portableById = new Map<string, PortableCheckpoint>();
  const candidates = new Map<string, { entry: SessionEntry; index: number }>();
  for (let index = 0; index < branch.length; index++) {
    const entry = branch[index];
    if (entry.type !== "custom_message" || entry.customType !== PORTABLE_ENTRY) continue;
    const id = object(entry.details)?.checkpointId;
    if (typeof id === "string") candidates.set(id, { entry, index });
  }
  let nativeIndex = -1;
  // Stop at the nearest readable baseline; obsolete records behind it are not
  // dependencies and cannot make otherwise readable active history unusable.
  for (let i = activeIndex; i >= 0; i--) {
    const entry = branch[i];
    if (entry.type !== "compaction") continue;
    if (!isServerCheckpointEntry(entry)) { nativeIndex = i; break; }
    const candidate = candidates.get(entry.id);
    if (candidate && candidate.index > i) {
      const portable = portableRecord(candidate.entry, entry.id, branch)!;
      portableById.set(entry.id, portable);
      nativeIndex = i;
      break;
    }
  }
  // Encrypted ancestors before the latest readable checkpoint are superseded and
  // need not validate. Those after it supply the active checkpoint's readable source.
  if (nativeIndex < 0 && branch[0]?.parentId !== null) return invalid();
  for (let i = Math.max(1, nativeIndex + 1); i < branch.length; i++) if (branch[i].parentId !== branch[i - 1].id) return invalid();
  const transformed = branch.map((entry, index): SessionEntry => {
    if (entry.type === "custom_message" && entry.customType === PORTABLE_ENTRY) return { type: "custom", id: entry.id, parentId: entry.parentId, timestamp: entry.timestamp, customType: "server-side-compaction.reconstruction-hidden.v1" };
    if (isServerCheckpointEntry(entry)) {
      const portable = portableById.get(entry.id);
      if (portable) return { ...entry, summary: portable.summary, details: { readFiles: (entry.details as ServerCheckpoint)?.readFiles ?? [], modifiedFiles: (entry.details as ServerCheckpoint)?.modifiedFiles ?? [] } };
      if (index > nativeIndex && index <= activeIndex) validateCheckpoint(entry, branch);
      return { type: "custom", id: entry.id, parentId: entry.parentId, timestamp: entry.timestamp, customType: "server-side-compaction.reconstruction-hidden.v1" };
    }
    return entry;
  });
  return buildSessionProjection(transformed);
}

/** Older prefix only; the retained boundary and everything after it stay outside. */
export function reconstructPrefix(branch: readonly SessionEntry[], firstKeptEntryId: string): AgentMessage[] {
  if (!branch.some(entry => entry.id === firstKeptEntryId)) return invalid();
  const projection = reconstructReadableProjection(branch);
  const boundary = projection.entries.findIndex(item => item.sourceEntry.id === firstKeptEntryId);
  if (boundary < 0) return invalid();
  const prefix = projection.entries.slice(0, boundary).flatMap(item => item.messages);
  if (prefix.length === 0) throw new Error("No readable source prefix is available for this checkpoint boundary.");
  return prefix;
}
