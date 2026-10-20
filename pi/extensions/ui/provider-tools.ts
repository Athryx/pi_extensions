import type { Theme } from "@earendil-works/pi-coding-agent";
import { stripTerminalSequences, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { providerToolCalls } from "../shared/provider-tools";

const inline = (value: string) => stripTerminalSequences(value).replace(/[\r\n\t]+/g, " ").replace(/[\x00-\x1f\x7f-\x9f]/g, "").trim();
const valid = (call: unknown): call is { id: string; label: string; summary: string; status: string } => {
  if (!call || typeof call !== "object") return false;
  const row = call as Record<string, unknown>;
  return typeof row.id === "string" && typeof row.label === "string" && typeof row.summary === "string" && typeof row.status === "string";
};
/** Snapshot displayed scalars so in-place edits invalidate without serializing history. */
export function providerToolKey(message: unknown): unknown[] {
  const calls = providerToolCalls(message);
  const key: unknown[] = [Math.min(calls.length, 256)];
  for (let index = 0; index < Math.min(calls.length, 256); index++) {
    const call = calls[index];
    if (valid(call)) key.push(call.id, call.label, call.summary, call.status); else key.push(undefined);
  }
  return key;
}
export function renderProviderTools(message: unknown, theme: Theme, width: number, padding = 1): string[] {
  if (width <= 0) return [];
  const lines: string[] = [];
  for (const call of providerToolCalls(message).slice(0, 256)) {
    if (!valid(call)) continue;
    const status = call.status === "running" ? theme.fg("muted", " ⋯") : call.status === "error" ? theme.fg("error", " ✗")
      : call.status === "cancelled" ? theme.fg("warning", " (cancelled)") : "";
    const suffix = truncateToWidth(status, width, "");
    const title = theme.fg("mdLink", theme.bold(inline(call.label)));
    const summary = inline(call.summary);
    const row = " ".repeat(Math.max(0, Math.min(3, padding))) + title + (summary ? " " + theme.fg("muted", summary) : "");
    lines.push("", truncateToWidth(row, Math.max(0, width - visibleWidth(suffix)), "") + suffix);
  }
  return lines;
}
