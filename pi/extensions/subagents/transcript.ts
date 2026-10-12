import {
  AssistantMessageComponent, UserMessageComponent, ToolExecutionComponent, CustomMessageComponent, getMarkdownTheme,
} from "@earendil-works/pi-coding-agent";
import { Container, Text, stripTerminalSequences, type TUI } from "@earendil-works/pi-tui";
import type { AgentRecord } from "./types";
export function safe(value: string): string {
  return stripTerminalSequences(value).replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f]/g, "");
}
export function transcript(record: AgentRecord, tui: TUI, expanded = false): Container {
  const container = new Container();
  const tools = new Map<string, ToolExecutionComponent>();
  const settings = record.session?.settingsManager ?? record.settings;
  for (const entry of record.messages) {
    if (entry.role === "assistant") {
      container.addChild(new AssistantMessageComponent(entry, settings?.getHideThinkingBlock() ?? false, getMarkdownTheme(), undefined, 0));
      for (const block of entry.content) if (block.type === "toolCall") {
        const definition = record.session?.extensionRunner.getToolDefinition(block.name);
        const renderer = record.session?.extensionRunner.resolveToolRenderers(block.name, () => definition);
        const component = new ToolExecutionComponent(block.name, block.id, block.arguments, {showImages: settings?.getShowImages() ?? false, imageWidthCells: settings?.getImageWidthCells(), outputPad: 0}, renderer, tui, record.context?.cwd ?? record.manager?.getCwd() ?? process.cwd());
        component.setArgsComplete(); component.setExpanded(expanded); tools.set(block.id, component); container.addChild(component);
      }
    } else if (entry.role === "user") {
      const content = typeof entry.content === "string" ? entry.content : entry.content.filter(c => c.type === "text").map(c => c.text).join("\n");
      container.addChild(new UserMessageComponent(content, getMarkdownTheme(), 0));
    } else if (entry.role === "toolResult") {
      tools.get(entry.toolCallId)?.updateResult({...entry});
    } else if (entry.role === "custom" && entry.display) {
      const content = typeof entry.content === "string" ? entry.content : entry.content.filter(c => c.type === "text").map(c => c.text).join("\n");
      container.addChild(new CustomMessageComponent({...entry, content: safe(content)}, record.session?.extensionRunner.getMessageRenderer(entry.customType), getMarkdownTheme(), 0));
    }
  }
  for (const [id, event] of record.toolUpdates ?? []) {
    const component = tools.get(id);
    component?.markExecutionStarted();
    if ("result" in event) component?.updateResult({...event.result, isError: event.type === "tool_execution_end" ? event.isError : false}, event.type !== "tool_execution_end");
  }
  if (!record.messages.length) container.addChild(new Text(record.error ?? "(No conversation yet)", 0, 0));
  return container;
}
