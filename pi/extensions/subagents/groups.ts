import { object } from "./config";
import { validName } from "./templates";
import type { AgentGroup, AgentOwnership } from "./types";
const ID = /^[a-zA-Z0-9_-]{1,100}$/;
export function groupId(value: unknown): asserts value is string {
  if (typeof value !== "string" || !ID.test(value)) throw new Error("Invalid agent group ID");
}
export function normalizeGroup(raw: unknown): AgentGroup {
  const d = object(raw, ["version", "id", "parentGroupId", "kind", "label", "rootAgentInstanceId", "workflowRunId", "agentName", "status", "error"], "group");
  groupId(d.id);
  if (d.version !== 1 || !["root", "workflow", "agents"].includes(d.kind as string)) throw new Error("Invalid agent group");
  if (d.parentGroupId !== null) groupId(d.parentGroupId);
  if (typeof d.label !== "string" || !d.label || d.label.length > 200) throw new Error("Invalid group label");
  if (d.rootAgentInstanceId !== null) groupId(d.rootAgentInstanceId);
  if (d.workflowRunId !== undefined) groupId(d.workflowRunId);
  if (d.agentName !== undefined) { if (typeof d.agentName !== "string" || d.kind !== "agents") throw new Error("Invalid reserved agent name"); validName(d.agentName); }
  if (d.status !== undefined && !["queued", "running", "completed", "failed", "cancelled"].includes(d.status as string)) throw new Error("Invalid group status");
  if (d.error !== undefined && typeof d.error !== "string") throw new Error("Invalid group error");
  if (d.kind === "root" && d.parentGroupId !== null || d.kind !== "root" && d.parentGroupId === null || d.kind === "workflow" && d.rootAgentInstanceId !== null) throw new Error("Invalid group hierarchy");
  return structuredClone(d) as unknown as AgentGroup;
}
export function validateGroups(groups: Map<string, AgentGroup>, rootId: string): void {
  if (groups.get(rootId)?.kind !== "root" || [...groups.values()].filter(g => g.kind === "root").length !== 1) throw new Error("Invalid group root");
  for (const group of groups.values()) {
    const parent = group.parentGroupId ? groups.get(group.parentGroupId) : undefined;
    if (group.kind === "agents" && parent && parent.kind !== "workflow" || group.kind === "workflow" && parent?.kind === "workflow") throw new Error("Invalid group parent kind");
    const visited = new Set<string>();
    let current: AgentGroup | undefined = group;
    while (current) {
      if (visited.has(current.id)) throw new Error("Cyclic agent groups");
      visited.add(current.id);
      if (current.parentGroupId === null) break;
      current = groups.get(current.parentGroupId);
      if (!current) throw new Error("Missing parent agent group");
    }
    if (!visited.has(rootId)) throw new Error("Agent group is outside workspace");
  }
}
export function normalizeOwnership(raw: unknown, maxDepth: number): AgentOwnership {
  const d = object(raw, ["ownerInstanceId", "ownerRunId", "ownerTaskRunId", "creationDepth", "depthScope", "inheritanceSourceInstanceId"], "ownership");
  if (d.depthScope !== undefined && d.depthScope !== "group") throw new Error("Invalid ownership depth scope");
  if (!Number.isInteger(d.creationDepth) || (d.creationDepth as number) < 0 || (d.creationDepth as number) > maxDepth) throw new Error("Invalid creation depth");
  for (const key of ["ownerInstanceId", "ownerRunId", "ownerTaskRunId", "inheritanceSourceInstanceId"]) if (d[key] !== undefined) groupId(d[key]);
  return structuredClone(d) as unknown as AgentOwnership;
}
