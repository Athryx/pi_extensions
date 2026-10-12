import type { Envelope } from "./types";
export const MESSAGE_KEY = "subagents.message.v1";
export function message(envelope: Envelope) {
  return {customType: MESSAGE_KEY, content: "Message from " + envelope.from + ":\n" + envelope.message, display: true, details: envelope};
}
export function text(value: string, field: string): string {
  if (!value.trim()) throw new Error(field + " must be nonempty");
  if (Buffer.byteLength(value) > 128 * 1024) throw new Error(field + " exceeds 128 KiB");
  return value;
}
