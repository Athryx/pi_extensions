import {
  AssistantMessageComponent, BashExecutionComponent, BranchSummaryMessageComponent,
  CompactionSummaryMessageComponent, CustomMessageComponent, ToolExecutionComponent,
  UserMessageComponent, SkillInvocationMessageComponent, parseSkillBlock, getMarkdownTheme,
} from "@earendil-works/pi-coding-agent";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { Container, Spacer, Text, stripTerminalSequences, type Component, type TUI } from "@earendil-works/pi-tui";
import type { ViewedSessionSnapshot } from "../shared/viewed-session";
import type { CompactView } from "./compact";

export function plainLabel(value: string): string {
  return stripTerminalSequences(value).replace(/[\x00-\x1f\x7f-\x9f]/g, " ");
}
type MessageRow = {message: AgentMessage; components: Component[]; streaming?: boolean};
type ToolRow = {component: ToolExecutionComponent; args: unknown; result?: unknown; update?: unknown; argsComplete?: boolean; started?: boolean};

/** Native components stay stable across deltas; no worker content is persisted in main. */
export class ViewedTranscript extends Container {
  readonly nestedCalls: CompactView["nestedCalls"] = new Map();
  private messages = new Map<string, MessageRow>();
  private tools = new Map<string, ToolRow>();
  private previous?: ViewedSessionSnapshot;
  private updates = new Map<string, unknown>();
  private expanded = false;
  private hideThinking = false;
  private session?: ViewedSessionSnapshot["session"];
  constructor(private tui: TUI) { super(); }

  sync(snapshot: ViewedSessionSnapshot): void {
    const updates = snapshot.toolUpdates ?? new Map();
    const unchanged = this.previous?.session === snapshot.session
      && this.previous?.settings === snapshot.settings
      && this.previous?.messages.length === snapshot.messages.length
      && this.previous.messages.every((message, index) => message === snapshot.messages[index])
      && this.updates.size === updates.size
      && [...updates].every(([id, update]) => this.updates.get(id) === update);
    // Providers can mutate the current assistant message in place, including
    // its transition from pending to finalized. Keep that tail live even when
    // the message/list identities did not change.
    const tail = snapshot.messages.at(-1);
    if (unchanged && tail?.role !== "assistant") return;
    const settings = snapshot.session?.settingsManager ?? snapshot.settings;
    if (!this.previous) this.hideThinking = settings?.getHideThinkingBlock() ?? false;
    // A reconstructed idle worker can acquire its live renderer runtime later.
    if (this.session !== snapshot.session) { this.messages.clear(); this.tools.clear(); }
    this.session = snapshot.session;
    const cwd = snapshot.session?.sessionManager.getCwd() ?? snapshot.manager?.getCwd() ?? process.cwd();
    const pad = settings?.getOutputPad() ?? 1;
    const transformers = snapshot.session?.extensionRunner.getMarkdownTransformers() ?? [];
    const children: Component[] = [];
    const seenMessages = new Set<string>(), seenTools = new Set<string>();
    const occurrences = new Map<string, number>();
    for (const message of snapshot.messages) {
      const base = `${message.role}:${message.timestamp}`;
      const occurrence = occurrences.get(base) ?? 0; occurrences.set(base, occurrence + 1);
      const key = `${base}:${occurrence}`;
      let row = this.messages.get(key);
      if (message.role === "assistant") {
        const streaming = message.stopReason === "pending";
        if (!row) row = {message, components: [new AssistantMessageComponent(message, this.hideThinking, getMarkdownTheme(), undefined, pad, transformers)]};
        else if (row.message !== message || streaming || row.streaming !== streaming) (row.components[0] as AssistantMessageComponent).updateContent(message, streaming);
        // Also mark initial partial messages as streaming when opening mid-response.
        if (!this.messages.has(key)) (row.components[0] as AssistantMessageComponent).updateContent(message, streaming);
        row.streaming = streaming;
        children.push(...row.components);
        for (const block of message.content) if (block.type === "toolCall") {
          let tool = this.tools.get(block.id);
          if (!tool) {
            const runner = snapshot.session?.extensionRunner;
            const definition = runner?.getToolDefinition(block.name);
            const renderer = runner?.resolveToolRenderers(block.name, () => definition);
            tool = {args: block.arguments, component: new ToolExecutionComponent(block.name, block.id, block.arguments, {
              showImages: settings?.getShowImages() ?? false, imageWidthCells: settings?.getImageWidthCells(), outputPad: pad,
            }, renderer, this.tui, cwd)};
            tool.component.setExpanded(this.expanded);
            this.tools.set(block.id, tool);
          } else if (tool.args !== block.arguments || message.stopReason === "pending") { tool.component.updateArgs(block.arguments); tool.args = block.arguments; }
          if (message.stopReason !== "pending" && !tool.argsComplete) { tool.component.setArgsComplete(); tool.argsComplete = true; }
          if ((message.stopReason === "aborted" || message.stopReason === "error") && !tool.result) {
            const result = {content: [{type: "text" as const, text: message.errorMessage ?? "Operation aborted"}], isError: true};
            tool.component.updateResult(result); tool.result = result;
          }
          seenTools.add(block.id); children.push(tool.component);
        }
      } else if (message.role === "toolResult") {
        const tool = this.tools.get(message.toolCallId);
        if (tool && tool.result !== message) { tool.component.updateResult(message); tool.result = message; }
      } else if (message.role !== "system") {
        if (!row || row.message !== message) {
          const components: Component[] = [];
          if (message.role === "user") {
            const text = typeof message.content === "string" ? message.content : message.content.filter(block => block.type === "text").map(block => block.text).join("\n");
            const skill = parseSkillBlock(text);
            if (text) components.push(new Spacer(1));
            if (skill) {
              components.push(new SkillInvocationMessageComponent(skill, getMarkdownTheme(), pad));
              if (skill.userMessage) components.push(new Spacer(1), new UserMessageComponent(skill.userMessage, getMarkdownTheme(), pad, transformers));
            } else if (text) components.push(new UserMessageComponent(text, getMarkdownTheme(), pad, transformers));
          } else if (message.role === "custom" && message.display) {
            components.push(new CustomMessageComponent(message, snapshot.session?.extensionRunner.getMessageRenderer(message.customType), getMarkdownTheme(), pad));
          } else if (message.role === "compactionSummary") {
            components.push(new Spacer(1), new CompactionSummaryMessageComponent(message, getMarkdownTheme(), pad));
          } else if (message.role === "branchSummary") {
            components.push(new Spacer(1), new BranchSummaryMessageComponent(message, getMarkdownTheme(), pad));
          } else if (message.role === "bashExecution") {
            const bash = new BashExecutionComponent(message.command, this.tui, message.excludeFromContext, pad);
            bash.appendOutput(message.output); bash.setComplete(message.exitCode, message.cancelled, message.truncated ? {truncated: true} as Parameters<BashExecutionComponent["setComplete"]>[2] : undefined, message.fullOutputPath);
            components.push(bash);
          }
          row = {message, components};
          for (const component of components) if ("setExpanded" in component) (component as Component & {setExpanded(value: boolean): void}).setExpanded(this.expanded);
        }
        children.push(...row.components);
      }
      if (row) { row.message = message; this.messages.set(key, row); seenMessages.add(key); }
    }
    for (const [id, event] of updates) {
      if (event.parentToolCallId) {
        // Retained end events are immutable snapshots. Do not clone the same
        // finalized result again on each assistant delta and invalidate its row.
        if (this.updates.get(id) === event && this.nestedCalls.has(id)) continue;
        const previous = this.nestedCalls.get(id);
        this.nestedCalls.set(id, {
          name: event.toolName, args: "args" in event ? event.args : previous?.args,
          running: event.type !== "tool_execution_end",
          result: event.type === "tool_execution_end" ? {...event.result, isError: event.isError} : previous?.result,
        });
      } else {
        const tool = this.tools.get(id);
        if (!tool || tool.update === event) continue;
        if (!tool.started) { tool.component.markExecutionStarted(); tool.started = true; }
        if (!tool.argsComplete) { tool.component.setArgsComplete(); tool.argsComplete = true; }
        if (event.type === "tool_execution_update") tool.component.updateResult({...event.partialResult, isError: false}, true);
        if (event.type === "tool_execution_end") tool.component.updateResult({...event.result, isError: event.isError, durationMs: event.durationMs});
        tool.update = event;
      }
    }
    for (const id of this.tools.keys()) if (!seenTools.has(id)) this.tools.delete(id);
    for (const key of this.messages.keys()) if (!seenMessages.has(key)) this.messages.delete(key);
    for (const id of this.nestedCalls.keys()) if (!updates.has(id)) this.nestedCalls.delete(id);
    this.children = children.length ? children : [new Text("(No conversation yet)", pad, 0)];
    this.updates = new Map(updates);
    // Copy the array: providers may mutate their live message list in place.
    this.previous = {...snapshot, messages: [...snapshot.messages]};
  }

  setExpanded(expanded: boolean): void {
    this.expanded = expanded;
    for (const component of this.children) if ("setExpanded" in component) (component as Component & {setExpanded(value: boolean): void}).setExpanded(expanded);
  }
  toggleThinking(): void {
    this.hideThinking = !this.hideThinking;
    for (const row of this.messages.values()) for (const component of row.components) if (component instanceof AssistantMessageComponent) component.setHideThinkingBlock(this.hideThinking);
  }
}
