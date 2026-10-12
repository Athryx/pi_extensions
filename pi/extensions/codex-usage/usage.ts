import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

export const USAGE_URL = "https://chatgpt.com/backend-api/wham/usage";
type Json = Record<string, unknown>;
const object = (value: unknown): Json | undefined => value !== null && typeof value === "object" && !Array.isArray(value) ? value as Json : undefined;
const number = (value: unknown): number | undefined => typeof value === "number" && Number.isFinite(value) ? value : undefined;
const bool = (value: unknown): boolean | undefined => typeof value === "boolean" ? value : undefined;
const clean = (value: unknown): string | undefined => typeof value === "string" ? value.replace(/[\x00-\x1f\x7f-\x9f]/g, "").slice(0, 200) : undefined;

export interface WindowUsage {
  label: string;
  seconds?: number;
  remaining?: number;
  resetAt?: number;
}
export interface LimitUsage {
  name: string;
  allowed?: boolean;
  reached?: boolean;
  windows: WindowUsage[];
}
export interface SubscriptionUsage {
  plan?: string;
  limits: LimitUsage[];
  credits?: { balance?: string; available?: boolean; unlimited?: boolean };
  fetchedAt: number;
}

function parseLimit(name: string, value: unknown, now: number): LimitUsage | undefined {
  const data = object(value);
  if (!data) return;
  const windows: WindowUsage[] = [];
  for (const key of ["primary_window", "secondary_window"]) {
    const window = object(data[key]);
    if (!window) continue;
    const seconds = number(window.limit_window_seconds);
    const used = number(window.used_percent);
    const reset = number(window.reset_at);
    const after = number(window.reset_after_seconds);
    windows.push({
      label: seconds === 18000 ? "5h" : seconds === 604800 ? "weekly" : seconds ? `${seconds / 3600}h` : key === "primary_window" ? "primary" : "secondary",
      seconds,
      remaining: used === undefined ? undefined : Math.max(0, Math.min(100, 100 - used)),
      resetAt: reset !== undefined && reset > 0 ? reset * 1000 : after !== undefined && after >= 0 ? now + after * 1000 : undefined,
    });
  }
  return { name, allowed: bool(data.allowed), reached: bool(data.limit_reached), windows };
}

export function parseUsage(value: unknown, now = Date.now()): SubscriptionUsage {
  const data = object(value);
  if (!data || !("rate_limit" in data || "plan_type" in data || "credits" in data)) {
    throw new Error("Codex returned an unrecognized usage response.");
  }
  const limits: LimitUsage[] = [];
  const main = parseLimit("Codex", data.rate_limit, now);
  if (main) limits.push(main);
  const review = parseLimit("Code review", data.code_review_rate_limit, now);
  if (review) limits.push(review);
  if (Array.isArray(data.additional_rate_limits)) {
    for (const item of data.additional_rate_limits) {
      const extra = object(item);
      if (!extra) continue;
      const limit = parseLimit(clean(extra.limit_name) || clean(extra.metered_feature) || "Additional limit", extra.rate_limit, now);
      if (limit) limits.push(limit);
    }
  }
  const credits = object(data.credits);
  return {
    plan: clean(data.plan_type), limits, fetchedAt: now,
    credits: credits ? {
      balance: clean(credits.balance) ?? (number(credits.balance)?.toString()),
      available: bool(credits.has_credits), unlimited: bool(credits.unlimited),
    } : undefined,
  };
}

export function tokenAccount(token: string): string | undefined {
  try {
    const payload = object(JSON.parse(Buffer.from(token.split(".")[1] ?? "", "base64url").toString("utf8")));
    const account = object(payload?.["https://api.openai.com/auth"])?.chatgpt_account_id;
    return typeof account === "string" && /^[\w-]+$/.test(account) ? account : undefined;
  } catch { return; }
}

export async function fetchUsage(ctx: ExtensionContext, signal: AbortSignal): Promise<SubscriptionUsage> {
  // Use Pi's auth resolver so it owns refresh-token rotation and locking. Never read/copy auth.json.
  const candidates = ctx.modelRegistry.getAll().filter(model => ["openai-codex", "openai"].includes(model.provider));
  if (ctx.model && ["openai-codex", "openai"].includes(ctx.model.provider)) candidates.unshift(ctx.model);
  const seen = new Set<string>();
  let token: string | undefined;
  let account: string | undefined;
  for (const model of candidates) {
    if (seen.has(model.provider)) continue;
    seen.add(model.provider);
    if (!ctx.modelRegistry.isUsingOAuth(model)) continue;
    const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model).catch(() => {
      throw new Error("Could not resolve Codex login. Reconnect with /login.");
    });
    if (signal.aborted) throw new Error("Usage polling cancelled.");
    if (!auth.ok) throw new Error("Could not resolve Codex login. Reconnect with /login.");
    const id = auth.apiKey ? tokenAccount(auth.apiKey) : undefined;
    if (id) { token = auth.apiKey; account = id; break; }
  }
  if (!token || !account) throw new Error("No compatible Codex subscription login. Use /login → OpenAI Codex; API keys and some direct ChatGPT logins do not support this endpoint.");
  let response: Response;
  try {
    response = await fetch(USAGE_URL, {
      headers: { Authorization: `Bearer ${token}`, "ChatGPT-Account-Id": account, Accept: "application/json" },
      signal, redirect: "error",
    });
  } catch {
    throw new Error(signal.aborted ? "Codex usage request timed out or was cancelled." : "Could not reach the Codex usage service.");
  }
  // Do not echo response bodies or underlying auth errors: they may contain secrets.
  if (!response.ok) {
    const advice = response.status === 401 || response.status === 403 ? " Reconnect with /login; this login may not support the usage endpoint." : response.status === 429 ? " Try again later." : "";
    throw new Error(`Codex usage request failed (HTTP ${response.status}).${advice}`);
  }
  let data: unknown;
  try { data = await response.json(); } catch { throw new Error("Codex returned invalid usage JSON."); }
  return parseUsage(data);
}

const percent = (value: number | undefined): string => value === undefined ? "?" : `${Math.floor(value)}%`;
export function footerText(usage: SubscriptionUsage | undefined, failed = false): string {
  if (!usage) return failed ? "Codex usage unavailable" : "";
  const windows = usage.limits.find(limit => limit.name === "Codex")?.windows ?? [];
  const parts = [604800, 18000].flatMap(seconds => {
    const window = windows.find(item => item.seconds === seconds);
    return window ? [`${window.label} ${percent(window.remaining)}`] : [];
  });
  return `${parts.length ? `Codex left: ${parts.join(" · ")}` : "Codex limits unavailable"}${failed ? " (stale)" : ""}`;
}

export function usageDetails(usage: SubscriptionUsage): string {
  const lines = ["Codex subscription usage", `Plan: ${usage.plan ?? "not reported"}`, `Updated: ${new Date(usage.fetchedAt).toLocaleString()}`];
  for (const limit of usage.limits) {
    lines.push(`\n${limit.name}${limit.reached ? " — limit reached" : limit.allowed === false ? " — unavailable" : ""}`);
    if (!limit.windows.length) lines.push("  No usage windows reported.");
    for (const window of limit.windows) {
      lines.push(`  ${window.label}: ${percent(window.remaining)} left${window.resetAt ? `; resets ${new Date(window.resetAt).toLocaleString()}` : "; reset not reported"}`);
    }
  }
  if (!usage.limits.length) lines.push("Usage limits not reported.");
  if (usage.credits) {
    lines.push(`\nCredits: ${usage.credits.unlimited ? "unlimited" : usage.credits.balance ?? "balance not reported"}${usage.credits.available === undefined ? "" : usage.credits.available ? " (available)" : " (none available)"}`);
  }
  lines.push("\nLimits are subscription-wide, not just this Pi session.", "Billing/renewal details are not provided by this endpoint.");
  return lines.join("\n");
}
