import type { AgentMessage } from "@earendil-works/pi-agent-core";
import {
  contentText,
  getCurrentSystemMessage,
  getSystemMessageText,
  toToolDeclaration,
  type SystemMessage,
  type Tool,
} from "@earendil-works/pi-ai";
import { convertToLlm, estimateTokens, type ContextUsage } from "@earendil-works/pi-coding-agent";

export interface ContextNode {
  id: string;
  label: string;
  text: string;
  tokens: number;
  children: ContextNode[];
}

export interface ContextSnapshot {
  source: string;
  note: string;
  model: string;
  usage: ContextUsage | undefined;
  roots: ContextNode[];
  tokens: number;
}

const json = (value: unknown) => JSON.stringify(value, null, 2) ?? "";
const textTokens = (text: string) => Math.ceil(text.length / 4);

function node(id: string, label: string, text: string, tokens = textTokens(text), children: ContextNode[] = []): ContextNode {
  return { id, label, text, tokens, children };
}

function group(id: string, label: string, children: ContextNode[], text?: string): ContextNode {
  return node(id, label, text ?? children.map(child => `${child.label}: ~${child.tokens.toLocaleString()} tokens`).join("\n"),
    children.reduce((total, child) => total + child.tokens, 0), children);
}

function toolNode(tool: Tool, id: string): ContextNode {
  const declaration = toToolDeclaration(tool);
  return node(id, tool.name, json(declaration), textTokens(JSON.stringify(declaration)));
}

function promptNode(system: SystemMessage): ContextNode {
  const children: ContextNode[] = [];
  const content = contentText(system.content);
  if (content) children.push(node("system:content", "Prompt text", content));
  for (const [name, text] of Object.entries(system.sections ?? {})) {
    if (text !== null) children.push(node(`system:${name}`, name.replace(/_/g, " "), text));
  }
  const prompt = getSystemMessageText(system);
  return node("system", "System prompt", prompt || "(empty system prompt)", textTokens(prompt), children);
}

/** Preserve the entire effective prompt, even when it is an opaque replacement. */
function effectivePrompt(prompt: string, replayed: SystemMessage | undefined): SystemMessage {
  if (replayed && getSystemMessageText(replayed) === prompt) return replayed;
  // Pi renders named sections as line-delimited XML. Keep intervening text as
  // independent pieces rather than silently losing custom prompt content.
  const sections: Record<string, string> = {};
  const pattern = /^<([a-z][a-z0-9_-]*)>\n[\s\S]*?^<\/\1>/gm;
  let start = 0;
  let piece = 0;
  for (const match of prompt.matchAll(pattern)) {
    const preceding = prompt.slice(start, match.index).trim();
    if (preceding) sections[piece++ === 0 ? "preamble" : `text_${piece}`] = preceding;
    let name = match[1];
    while (Object.hasOwn(sections, name)) name += "_";
    sections[name] = match[0];
    start = match.index! + match[0].length;
  }
  const tail = prompt.slice(start).trim();
  if (tail) sections[`text_${++piece}`] = tail;
  // Use parsed sections only when they reproduce the prompt exactly.
  const parsed: SystemMessage = { role: "system", content: "", sections, timestamp: 0 };
  return getSystemMessageText(parsed) === prompt ? parsed : { role: "system", content: prompt, timestamp: 0 };
}

function blockText(block: Record<string, unknown>): { label: string; text: string } {
  switch (block.type) {
    case "text": return { label: "Text", text: String(block.text ?? "") };
    case "thinking": return {
      label: block.redacted ? "Thinking (redacted)" : "Thinking",
      text: String(block.thinking ?? "") || "(no visible thinking text)",
    };
    case "toolCall": return {
      label: `Tool call: ${block.name}`,
      text: `Tool: ${block.name}\nCall ID: ${block.id}\n\n${json(block.arguments)}`,
    };
    case "image": return {
      label: `Image: ${block.mimeType}`,
      text: `Image attachment\nMIME type: ${block.mimeType}\nBase64 size: ${String(block.data ?? "").length.toLocaleString()} characters\n\nImage data is not rendered as text. Token cost depends on the provider and image dimensions.`,
    };
    default: return { label: String(block.type ?? "Content"), text: json(block) };
  }
}

function messageNode(message: AgentMessage, index: number): ContextNode | undefined {
  const converted = convertToLlm([message])[0];
  if (!converted) return undefined; // Includes !! shell commands and unknown UI-only roles.
  const id = `message:${index}`;
  const tokens = estimateTokens(converted);
  if (message.role === "system") {
    const children: ContextNode[] = [];
    const content = contentText(message.content);
    if (content) children.push(node(`${id}:content`, "Appended instructions", content));
    for (const [name, text] of Object.entries(message.sections ?? {})) {
      children.push(node(`${id}:section:${name}`, `Section: ${name}`, text ?? "(removed)", text === null ? 0 : textTokens(text)));
    }
    for (const tool of message.toolsAdded ?? []) children.push(toolNode(tool, `${id}:tool:${tool.name}`));
    if (message.toolsRemoved?.length) children.push(node(`${id}:removed`, "Removed tools", json(message.toolsRemoved), 0));
    return node(id, `#${index + 1} System update`, json(message), tokens, children);
  }
  const children: ContextNode[] = [];
  const content = converted.content;
  if (typeof content === "string") {
    children.push(node(`${id}:text`, "Text", content));
  } else {
    for (const [i, block] of content.entries()) {
      const detail = blockText(block as unknown as Record<string, unknown>);
      const single = { ...converted, content: [block] } as AgentMessage;
      children.push(node(`${id}:block:${i}`, detail.label, detail.text, estimateTokens(single)));
    }
  }
  const role = message.role === "toolResult" ? `Tool result: ${message.toolName}${message.isError ? " (error)" : ""}`
    : message.role === "custom" ? `Extension: ${message.customType}`
    : message.role === "compactionSummary" ? "Compaction summary"
    : message.role === "branchSummary" ? "Branch summary"
    : message.role === "bashExecution" ? "Shell command"
    : message.role === "assistant" ? "Assistant" : "User";
  const preview = children.find(child => child.label === "Text")?.text.replace(/\s+/g, " ").slice(0, 70);
  const label = `#${index + 1} ${role}${preview ? ` · ${preview}` : ""}`;
  const text = children.map(child => `── ${child.label} ──\n${child.text}`).join("\n\n") || "(empty message)";
  return node(id, label, text, tokens, children.length > 1 || message.role === "assistant" ? children : []);
}

export function buildSnapshot(options: {
  messages: AgentMessage[];
  source: string;
  model: string;
  usage?: ContextUsage;
  /** Omit these for a captured request: its transcript owns prompt/tool state. */
  current?: { prompt: string; tools: Tool[] };
}): ContextSnapshot {
  const { messages, current } = options;
  const replayed = getCurrentSystemMessage(messages);
  const system = current ? effectivePrompt(current.prompt, replayed) : messages.find(m => m.role === "system") as SystemMessage | undefined;
  const tools = current?.tools ?? system?.toolsAdded ?? [];
  const conversation = messages.flatMap((message, index) => {
    if (current && message.role === "system") return [];
    if (!current && message === system) return [];
    const entry = messageNode(message, index);
    return entry ? [entry] : [];
  });
  const roots = [
    promptNode(system ?? { role: "system", content: "", timestamp: 0 }),
    group("tools", "Tool definitions", tools.map((tool, i) => toolNode(tool, `tool:${i}:${tool.name}`))),
    group("conversation", "Conversation", conversation),
  ];
  return {
    source: options.source,
    model: options.model,
    usage: options.usage,
    note: current
      ? "Effective prompt + active tool schemas + finalized branch context. Request-time transforms may differ; press r for the last captured request."
      : "Transcript captured at this extension's context_with_system hook, before provider serialization. Later handlers may still change it.",
    roots,
    tokens: roots.reduce((total, root) => total + root.tokens, 0),
  };
}
