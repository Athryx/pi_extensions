import type { Theme } from "@earendil-works/pi-coding-agent";
import { stripTerminalSequences, truncateToWidth, visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";

interface Result { isError?: boolean; details?: unknown; content?: {type: string; text?: string}[] }
export interface CustomToolRow {
  name: string; args: unknown; result?: Result;
  isPartial?: boolean; executionStarted?: boolean; outputPad?: number;
}
export interface AgentMessageInput { customType: string; content?: unknown; details?: unknown; display?: boolean }
const object = (value: unknown): Record<string, unknown> => value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
const label = (name: string) => name.split(/[.:/]/).pop() || name;

/** Display-only sanitization: preserve all text/newlines, never terminal controls. */
function text(value: unknown): string {
  return stripTerminalSequences(typeof value === "string" ? value : String(value ?? ""))
    .replace(/\r\n?/g, "\n").replace(/\t/g, "    ").replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f]/g, "");
}
const inline = (value: unknown) => text(value).replace(/\n/g, " ↵ ").trim();
const padSize = (padding: number | undefined) => Math.max(0, Math.min(3, padding ?? 1));

function header(title: string, args: string, row: CustomToolRow, theme: Theme, width: number): string {
  const status = row.result?.isError ? theme.fg("error", " ✗")
    : row.isPartial ? theme.fg("muted", row.executionStarted ? " ⋯" : " …") : "";
  const suffix = truncateToWidth(status, width, "");
  const line = " ".repeat(padSize(row.outputPad)) + theme.fg("mdLink", theme.bold(title)) + (args ? " " + theme.fg("muted", args) : "");
  return truncateToWidth(line, Math.max(0, width - visibleWidth(suffix))) + suffix;
}

/** Full body, with hanging labels when space permits; tiny widths still fit. */
function body(value: string, theme: Theme, width: number, padding: number, key = "", color: "muted" | "success" | "warning" = "muted"): string[] {
  if (width <= 0) return [];
  const indent = " ".repeat(Math.min(padding, Math.max(0, width - 1)));
  const prefix = key ? `${key}: ` : "";
  const hanging = visibleWidth(indent + prefix) < width;
  const available = Math.max(1, width - visibleWidth(indent) - (hanging ? prefix.length : 0));
  const content = (hanging ? "" : prefix) + text(value);
  let first = true;
  const lines: string[] = [];
  for (const source of content.split("\n")) {
    const wrapped = source ? wrapTextWithAnsi(theme.fg(color, source), available) : [""];
    for (const line of wrapped) {
      const start = indent + (hanging ? first ? theme.fg("muted", prefix) : " ".repeat(prefix.length) : "");
      lines.push(truncateToWidth(start + line, width, ""));
      first = false;
    }
  }
  return lines;
}
export function isQuestionTool(name: string): boolean { return ["ask_question", "ask_questions"].includes(label(name)); }

function questionDetails(result: Result | undefined): Record<string, unknown>[] {
  let details = object(result?.details);
  if (!Object.keys(details).length) {
    const content = result?.content?.find(block => block.type === "text")?.text;
    if (content) try { details = object(JSON.parse(content)); } catch { /* Legacy/plain results aren't JSON. */ }
  }
  const values = Array.isArray(details.questions) ? details.questions : typeof details.question === "string" ? [details] : [];
  return values.map(object).filter(question => typeof question.question === "string");
}

function questions(row: CustomToolRow, theme: Theme, width: number, heading: boolean): string[] | undefined {
  const args = object(row.args);
  const requested = (Array.isArray(args.questions) ? args.questions : typeof args.question === "string" ? [args] : [])
    .map(object).filter(question => typeof question.question === "string");
  const answered = questionDetails(row.result);
  if (!requested.length && !answered.length) return;
  // Results can be reordered; match by question text, consuming duplicate
  // occurrences separately rather than silently merging distinct answers.
  const byQuestion = new Map<string, number[]>();
  answered.forEach((question, index) => {
    const key = question.question as string;
    const queue = byQuestion.get(key) ?? []; queue.push(index); byQuestion.set(key, queue);
  });
  const used = new Set<number>();
  const pairs = requested.map(question => {
    const index = byQuestion.get(question.question as string)?.shift();
    if (index !== undefined) used.add(index);
    return {question, answer: index === undefined ? undefined : answered[index]};
  });
  answered.forEach((question, index) => { if (!used.has(index)) pairs.push({question, answer: question}); });
  const lines = heading ? [header("ask_question", "", row, theme, width)] : [];
  const padding = padSize(row.outputPad) + 2;
  const cancelled = row.result?.content?.some(block => block.type === "text" && /^(?:User cancelled the questions\.|Cancelled)$/i.test(block.text?.trim() ?? ""));
  for (const pair of pairs) {
    lines.push(...body(pair.question.question as string, theme, width, padding, "question"));
    const response = pair.answer?.answer;
    const answer = object(response);
    const value = typeof response === "string" ? response : typeof answer.answer === "string" ? answer.answer : undefined;
    const state = row.result?.isError ? "Failed" : row.isPartial || !row.result ? "Pending" : (pair.answer && response === null) || cancelled ? "Cancelled" : "Unavailable";
    const completedAnswer = !row.result?.isError && !row.isPartial ? value : undefined;
    lines.push(...body(completedAnswer ?? state, theme, width, padding, "answer", completedAnswer !== undefined ? "success" : state === "Cancelled" || state === "Failed" ? "warning" : "muted"));
    const notes = typeof answer.notes === "string" ? answer.notes : pair.answer?.notes;
    if (completedAnswer !== undefined && typeof notes === "string" && notes) lines.push(...body(notes, theme, width, padding, "notes"));
  }
  return lines;
}

/** Known repo tools get useful operational arguments; arbitrary payloads stay out. */
export function customToolSummary(name: string, input: unknown, result?: Result): string | undefined {
  const args = object(input), details = object(result?.details);
  switch (label(name)) {
    case "set_goal": return inline(args.goal) || "…";
    case "set_goal_status": return `${inline(args.status) || "…"}${args.reason ? ` · reason: ${inline(args.reason)}` : ""}`;
    case "finish_plan": return `approved=${typeof args.approved === "boolean" ? args.approved : "…"}`;
    case "wait_message": {
      const senders = Array.isArray(details.messages) ? details.messages.map(value => inline(object(value).from)).filter(Boolean) : [];
      const state = details.status === "received" ? ` · received from ${senders.join(", ") || "agent"}` : details.status === "timeout" ? " · timed out" : "";
      return `timeout=${inline(args.timeout ?? 120)}s${state}`;
    }
    case "list_agents": return `${args.all === true ? "all agents in group" : "direct children"}${Array.isArray(result?.details) ? ` · ${result.details.length} agents` : ""}`;
    case "workflow": return `${inline(args.path) || "…"}${typeof details.status === "string" ? ` · ${inline(details.status)}` : ""}`;
    case "interact_bash": return `${inline(args.session_name) || "…"} · ${typeof args.stdin === "string" && args.stdin ? "send input" : "poll"}${args.yield_time_ms !== undefined ? ` · wait=${inline(args.yield_time_ms)}ms` : ""}`;
    case "close_bash": return inline(args.session_name) || "…";
  }
}

/** Return undefined to retain generic compact rendering for an unknown shape. */
export function renderCustomTool(row: CustomToolRow, theme: Theme, width: number, options: {heading?: boolean} = {}): string[] | undefined {
  if (width <= 0) return [];
  const name = label(row.name), args = object(row.args);
  if (isQuestionTool(name)) return questions(row, theme, width, options.heading !== false);
  if (name === "send_message") return [
    header("send message to", inline(args.agent_name) || "…", row, theme, width),
    ...body(typeof args.message === "string" ? args.message : "…", theme, width, padSize(row.outputPad) + 2),
  ];
  if (name === "create_agent") return [
    header("create agent", `${inline(args.name) || "…"} · template: ${inline(args.agent_template) || "default"}`, row, theme, width),
    ...body(typeof args.task === "string" ? args.task : typeof args.prompt === "string" ? args.prompt : "…", theme, width, padSize(row.outputPad) + 2),
  ];
}

/** Workspace receives are custom messages, not wait_message tool output. */
export function renderAgentMessage(message: AgentMessageInput, theme: Theme, width: number, padding = 1): string[] | undefined {
  if (message.customType !== "subagents.message.v1" || message.display === false) return;
  if (width <= 0) return [];
  const details = object(message.details);
  let from = typeof details.from === "string" ? details.from : undefined;
  let content = typeof details.message === "string" ? details.message : undefined;
  if (from === undefined || content === undefined) {
    const raw = typeof message.content === "string" ? message.content : Array.isArray(message.content) ? message.content.map(object).filter(block => block.type === "text").map(block => block.text).join("\n") : "";
    const match = /^Message from ([^\r\n:]+):\r?\n([\s\S]*)$/.exec(raw);
    if (!match) return;
    from = match[1]; content = match[2];
  }
  return [header("receive message from", inline(from), {name: "receive_message", args: {}, outputPad: padding}, theme, width), ...body(content, theme, width, padSize(padding) + 2)];
}
