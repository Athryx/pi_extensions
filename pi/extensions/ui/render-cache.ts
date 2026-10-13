import type { Theme } from "@earendil-works/pi-coding-agent";
import type { AgentMessageInput, CustomToolRow } from "./custom-tools";

export interface RenderCache { key: unknown[]; lines: string[] }
export function sameKey(previous: readonly unknown[] | undefined, next: readonly unknown[]): boolean {
  return !!previous && previous.length === next.length && previous.every((value, index) => Object.is(value, next[index]));
}
export function themeKey(theme: Theme): unknown[] {
  return [theme, theme.colors, theme.getColorMode(), theme.appearance];
}
const object = (value: unknown): Record<string, unknown> => value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};

/** Snapshot displayed scalars, not JSON/stringified payloads, on spinner frames.
 * Providers may mutate arguments/results in place, so identity alone is not sufficient.
 * Keep these dependencies in sync with compact.ts and custom-tools.ts.
 */
export function toolKey(row: CustomToolRow, showCode: boolean): unknown[] {
  const args = object(row.args), result = row.result, details = object(result?.details);
  const name = row.name.split(/[.:/]/).pop();
  const key: unknown[] = [row.name, row.args, result, result?.isError, result?.details,
    row.isPartial, row.executionStarted, row.outputPad];
  for (const [field, value] of Object.entries(args)) {
    if (!/token|secret|password|content|stdin|code|edits/i.test(field)
      && (value === null || ["string", "number", "boolean"].includes(typeof value))) key.push(field, value);
  }
  if (name === "write") key.push(args.content);
  if (name === "codemode" && showCode) key.push(typeof row.args === "string" ? row.args : args.code);
  if (name === "interact_bash") key.push(typeof args.stdin === "string" && !!args.stdin);
  if (name === "read") {
    const truncation = object(details.truncation);
    key.push(truncation.outputLines, truncation.firstLineExceedsLimit,
      result?.content?.find(block => block.type === "text")?.text);
  }
  if (name === "edit") key.push(details.diff, details.firstChangedLine);
  if (name === "wait_message") {
    key.push(details.status);
    if (Array.isArray(details.messages)) for (const message of details.messages) key.push(object(message).from);
  }
  if (name === "list_agents") key.push(Array.isArray(result?.details) ? result.details.length : undefined);
  if (name === "ask_question" || name === "ask_questions") {
    const requested = Array.isArray(args.questions) ? args.questions : [args];
    const answered = Array.isArray(details.questions) ? details.questions : [details];
    key.push(requested.length, answered.length, Object.keys(details).length);
    for (const question of requested) key.push(object(question).question);
    for (const value of answered) {
      const question = object(value), answer = object(question.answer);
      key.push(question.question, question.answer, answer.answer, answer.notes, question.notes);
    }
    // Legacy JSON results and cancellation markers are rendered from content.
    key.push(result?.content?.length);
    for (const block of result?.content ?? []) key.push(block.type, block.text);
  }
  return key;
}

export function messageKey(message: AgentMessageInput): unknown[] {
  const details = object(message.details);
  const key: unknown[] = [message, message.customType, message.display, message.details, details.from, details.message];
  if (Array.isArray(message.content)) {
    key.push(message.content.length);
    for (const block of message.content) key.push(object(block).type, object(block).text);
  } else key.push(message.content);
  return key;
}
