import { open } from "node:fs/promises";
import { join } from "node:path";
import { getAgentDir, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { getAdapter } from "./openai.ts";

export type Mode = "auto" | "pi" | "server";
export interface Config {
  /** Runtime-only fail-closed flag; not accepted in configuration files. */
  serverDisabled?: boolean;
  mode: Mode;
  providers: Record<string, Mode>;
  models: Record<string, Mode>;
  timeoutMs: number;
  maxResponseBytes: number;
}
export const DEFAULT_CONFIG: Readonly<Config> = Object.freeze({
  mode: "auto", providers: Object.freeze({}), models: Object.freeze({}),
  timeoutMs: 120_000, maxResponseBytes: 32 * 1024 * 1024,
});
export const isMode = (value: unknown): value is Mode => value === "auto" || value === "pi" || value === "server";
const record = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value) && [Object.prototype, null].includes(Object.getPrototypeOf(value));
const providerKey = /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/;
const safeKey = (key: string) => !["__proto__", "prototype", "constructor"].includes(key);

/** Strict extension-owned schema. Error messages never interpolate supplied values. */
export function parseConfig(value: unknown): Partial<Config> {
  if (!record(value)) throw new Error("Configuration must be a JSON object.");
  const allowed = new Set(["mode", "providers", "models", "timeoutMs", "maxResponseBytes"]);
  if (Object.keys(value).some(key => !allowed.has(key))) throw new Error("Unknown configuration field; allowed: mode, providers, models, timeoutMs, maxResponseBytes.");
  const result: Partial<Config> = {};
  if (Object.hasOwn(value, "mode")) {
    if (!isMode(value.mode)) throw new Error("mode must be auto, pi, or server.");
    result.mode = value.mode;
  }
  for (const field of ["providers", "models"] as const) {
    if (!Object.hasOwn(value, field)) continue;
    const map = value[field];
    if (!record(map)) throw new Error(`${field} must be an object mapping exact keys to modes.`);
    const parsed: Record<string, Mode> = Object.create(null);
    for (const [key, mode] of Object.entries(map)) {
      const slash = key.indexOf("/");
      const validKey = field === "providers" ? providerKey.test(key) : slash > 0 && providerKey.test(key.slice(0, slash)) && key.length > slash + 1 && !/[\s\x00-\x1f\x7f]/.test(key);
      if (!safeKey(key) || !validKey || key.length > 1024 || !isMode(mode)) throw new Error(`${field} contains an invalid exact override key or mode.`);
      parsed[key] = mode;
    }
    result[field] = parsed;
  }
  for (const [field, min, max] of [["timeoutMs", 1_000, 600_000], ["maxResponseBytes", 1024, 128 * 1024 * 1024]] as const) {
    if (!Object.hasOwn(value, field)) continue;
    const n = value[field];
    if (typeof n !== "number" || !Number.isSafeInteger(n) || n < min || n > max) throw new Error(`${field} must be an integer between ${min} and ${max}.`);
    result[field] = n;
  }
  return result;
}

/** Trust must come from the host, not configuration contents or filesystem ownership. */
export async function loadConfig(ctx: Pick<ExtensionContext, "cwd" | "isProjectTrusted">, options: { agentDir?: string } = {}): Promise<{ config: Config; warnings: string[]; valid: boolean }> {
  let config: Config = { ...DEFAULT_CONFIG, providers: {}, models: {} };
  const warnings: string[] = [];
  const paths = [join(options.agentDir ?? getAgentDir(), "server-side-compaction.json")];
  if (ctx.isProjectTrusted?.() === true) paths.push(join(ctx.cwd, ".pi", "server-side-compaction.json"));
  for (const path of paths) {
    try {
      const handle = await open(path, "r");
      let text: string;
      try {
        const buffer = Buffer.alloc(1024 * 1024 + 1);
        let size = 0;
        while (size < buffer.length) {
          const read = await handle.read(buffer, size, buffer.length - size, null);
          if (read.bytesRead === 0) break;
          size += read.bytesRead;
        }
        if (size > 1024 * 1024) throw new Error("Configuration exceeds 1 MiB.");
        text = buffer.subarray(0, size).toString("utf8");
      } finally { await handle.close(); }
      let value: unknown;
      try { value = JSON.parse(text); } catch { throw new Error("Invalid JSON; check syntax."); }
      const parsed = parseConfig(value);
      config = { ...config, ...parsed, providers: { ...config.providers, ...parsed.providers }, models: { ...config.models, ...parsed.models } };
    } catch (error) {
      if ((error as NodeJS.ErrnoException)?.code === "ENOENT") continue;
      const detail = error instanceof Error && /^(Configuration|Invalid JSON|Unknown configuration|mode |providers |models |timeoutMs |maxResponseBytes )/.test(error.message) ? error.message : "Could not read configuration; check permissions.";
      warnings.push(`Server compaction disabled: ${path}: ${detail}`);
    }
  }
  // Invalid configuration is fail-closed even when a branch override requests server.
  return { config: warnings.length ? { ...config, mode: "pi", serverDisabled: true } : config, warnings, valid: warnings.length === 0 };
}

export function resolvePolicy(model: { provider: string; id: string; api?: string; baseUrl?: string } | undefined, config: Config, branchMode?: Mode, supported = !!getAdapter(model)) {
  const mode = branchMode ?? (model ? config.models[`${model.provider}/${model.id}`] ?? config.providers[model.provider] : undefined) ?? config.mode;
  if (config.serverDisabled) return { mode, backend: "pi" as const, reason: "Invalid configuration disabled server compaction; fix the configuration and reload." };
  if (mode === "pi") return { mode, backend: "pi" as const, reason: "Pi selected by policy." };
  if (!supported) return { mode, backend: "pi" as const, reason: "No supported official OpenAI Responses endpoint; using Pi." };
  return { mode, backend: "server" as const, reason: "Supported official OpenAI Responses endpoint." };
}
