import type { Usage } from "@earendil-works/pi-ai";
export type NodeStatus = "pending" | "queued" | "running" | "completed" | "failed" | "cancelled" | "skipped";
export type NodeKind = "workflow" | "sequence" | "parallel" | "stage" | "branch" | "agent";
export interface ProgressNode {
  id: string; parent?: string; kind: NodeKind; label: string; status: NodeStatus;
  children: string[]; startedAt?: number; endedAt?: number; agentName?: string; groupId?: string;
  activeStage?: number; previousStage?: number;
}
export interface WorkflowDetails {
  id: string; sourcePath: string; revision: number; status: NodeStatus;
  nodes: ProgressNode[]; fullOutputPath?: string;
}
export function emptyUsage(): Usage {
  return {input:0, output:0, cacheRead:0, cacheWrite:0, totalTokens:0,
    cost:{input:0,output:0,cacheRead:0,cacheWrite:0,total:0}};
}
export function addUsage(target: Usage, value: Partial<Usage> | undefined): void {
  if (!value) return;
  for (const key of ["input","output","cacheRead","cacheWrite","totalTokens"] as const) target[key] += value[key] ?? 0;
  for (const key of ["input","output","cacheRead","cacheWrite","total"] as const) target.cost[key] += value.cost?.[key] ?? 0;
}
export function record(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Expected an object");
  for (const key of Object.keys(value)) if (!keys.includes(key)) throw new Error("Unknown field: " + key);
  return value as Record<string, unknown>;
}
export function string(value: unknown, field: string): string {
  if (typeof value !== "string" || !value.length) throw new Error(field + " must be a non-empty string");
  return value;
}
export function label(value: unknown, fallback: string): string {
  if (value === undefined) return fallback;
  const result = string(value, "label");
  if ([...result].length > 80) throw new Error("Status labels must be at most 80 characters");
  return result.replace(/[\x00-\x1f\x7f-\x9f]/g, " ");
}
