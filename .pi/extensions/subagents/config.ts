import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, resolve } from "node:path";
import type { Config } from "./types";
export function object(value: unknown, keys: string[], where: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(where + " must be an object");
  for (const key of Object.keys(value)) if (!keys.includes(key)) throw new Error(where + ": unknown field " + key);
  return value as Record<string, unknown>;
}
export function strings(value: unknown, where: string): string[] {
  if (!Array.isArray(value) || value.some(v => typeof v !== "string" || !v.trim())) throw new Error(where + " must be a list of nonempty strings");
  return [...new Set(value as string[])];
}
export function pathFrom(base: string, path: string): string {
  return resolve(base, path === "~" ? homedir() : path.startsWith("~/") ? resolve(homedir(), path.slice(2)) : path);
}
export async function loadConfig(agentDir: string, cwd: string, trusted: boolean): Promise<Config> {
  const result: Config = { agent_paths: [], max_running: 8, max_depth: 4, worker_exclude_extensions: [] };
  for (const file of [resolve(agentDir, "subagents.json"), ...(trusted ? [resolve(cwd, ".pi/subagents.json")] : [])]) {
    let text: string;
    try { text = await readFile(file, "utf8"); } catch (e) { if ((e as NodeJS.ErrnoException).code === "ENOENT") continue; throw e; }
    const data = object(JSON.parse(text), Object.keys(result), file);
    for (const key of ["agent_paths", "worker_exclude_extensions"] as const) {
      if (data[key] !== undefined) result[key].push(...strings(data[key], key).map(p => pathFrom(dirname(file), p)));
    }
    for (const key of ["max_running", "max_depth"] as const) {
      if (data[key] !== undefined) {
        if (!Number.isSafeInteger(data[key]) || (data[key] as number) < 1 || (data[key] as number) > 128) throw new Error(key + " must be an integer from 1 to 128");
        result[key] = data[key] as number;
      }
    }
  }
  return result;
}
