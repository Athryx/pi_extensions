import { open } from "node:fs/promises";
import { join } from "node:path";
import { getAgentDir, type ExtensionContext } from "@earendil-works/pi-coding-agent";

export type Mode = "live" | "cached";
export const MODE_ENTRY = "codex-web-search.mode.v1";
export const isMode = (value: unknown): value is Mode => value === "live" || value === "cached";

export function parseConfig(value: unknown): { mode?: Mode } {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Configuration must be an object.");
  const record = value as Record<string, unknown>;
  if (Object.keys(record).some(key => key !== "mode")) throw new Error("Unknown configuration field; allowed: mode.");
  if (Object.hasOwn(record, "mode") && !isMode(record.mode)) throw new Error("mode must be live or cached.");
  return Object.hasOwn(record, "mode") ? { mode: record.mode as Mode } : {};
}

export interface Configuration { mode: Mode; source: "default" | "user config" | "project config"; warnings: string[] }
export async function loadConfig(ctx: Pick<ExtensionContext, "cwd" | "isProjectTrusted">, agentDir = getAgentDir()): Promise<Configuration> {
  const config: Configuration = { mode: "live", source: "default", warnings: [] };
  const locations: { path: string; source: Configuration["source"] }[] = [{ path: join(agentDir, "codex-web-search.json"), source: "user config" }];
  if (ctx.isProjectTrusted()) locations.push({ path: join(ctx.cwd, ".pi", "codex-web-search.json"), source: "project config" });
  for (const { path, source } of locations) {
    try {
      const file = await open(path, "r");
      let value: unknown;
      try {
        const buffer = Buffer.alloc(65537);
        let size = 0;
        while (size < buffer.length) {
          const read = await file.read(buffer, size, buffer.length - size, null);
          if (!read.bytesRead) break;
          size += read.bytesRead;
        }
        if (size > 65536) throw new Error("Configuration exceeds 64 KiB.");
        value = JSON.parse(buffer.subarray(0, size).toString("utf8"));
      } finally { await file.close(); }
      const parsed = parseConfig(value);
      if (parsed.mode) { config.mode = parsed.mode; config.source = source; }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") config.warnings.push(`Web search disabled: invalid or unreadable configuration at ${path}. Expected {"mode":"live"} or {"mode":"cached"}.`);
    }
  }
  return config;
}

/** Read the selected branch, rather than caching state from an abandoned branch. */
export function conversationMode(branch: readonly { type: string; customType?: string; data?: unknown }[]): Mode | undefined {
  for (let index = branch.length - 1; index >= 0; index--) {
    const entry = branch[index];
    if (entry.type !== "custom" || entry.customType !== MODE_ENTRY) continue;
    const data = entry.data as { version?: unknown; mode?: unknown } | undefined;
    if (data?.version === 1 && (data.mode === null || isMode(data.mode))) return data.mode ?? undefined;
  }
}
