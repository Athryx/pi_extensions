import { homedir } from "node:os";
import { AssistantMessageComponent, type Theme } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth, wrapTextWithAnsi, type Component, type TUI } from "@earendil-works/pi-tui";
import { highlightCompactCode } from "./syntax-highlight.js";
import { emphasize } from "./emphasis.js";
import { customToolSummary, isQuestionTool, renderCustomTool, renderCustomMessage, isCompactMessageType } from "./custom-tools";
import type { AgentMessageInput } from "./custom-tools";
import { messageKey, sameKey, themeKey, toolKey, type RenderCache } from "./render-cache.js";
import { providerToolKey, renderProviderTools } from "./provider-tools";

// Pi exposes renderers, but no transcript-layout hook. Keep the only internal
// dependency here: runtime fields on tool, assistant, and known custom-message
// components. Never replace tool definitions, prototypes,
// transcript entries, or another tool's renderer.
interface ToolRow extends Component {
  toolName: string;
  toolCallId: string;
  args: unknown;
  cwd?: string;
  outputPad?: number;
  executionStarted: boolean;
  isPartial: boolean;
  result?: { isError?: boolean; details?: unknown; content?: { type: string; text?: string }[] };
  setExpanded(expanded: boolean): void;
}
interface Branch extends Component {
  children: Component[];
}
interface AgentMessageRow extends Component {
  message: AgentMessageInput;
  outputPad?: number;
}
interface AssistantRow extends Component { lastMessage: unknown; outputPad?: number }
function isAssistantRow(component: Component): component is AssistantRow { return component instanceof AssistantMessageComponent; }
interface GroupPosition {
  grouped: boolean;
  first: boolean;
}
interface GroupCache { key: unknown[]; positions: Map<ToolRow, GroupPosition> }
interface NestedRows {
  children: ToolRow[];
  entries: Map<string, { row: ToolRow; preview?: string; parsed: boolean; args?: unknown }>;
}
type NestedCall = { name: string; args: unknown; result?: ToolRow["result"]; running: boolean };
const NESTED_FAILURE = Object.freeze({ isError: true });

function isToolRow(component: Component): component is ToolRow {
  const row = component as Partial<ToolRow>;
  return typeof row.toolName === "string" && typeof row.toolCallId === "string"
    && "args" in row && typeof row.setExpanded === "function"
    && typeof row.executionStarted === "boolean" && typeof row.isPartial === "boolean";
}
function isAgentMessage(component: Component): component is AgentMessageRow {
  return isCompactMessageType((component as Partial<AgentMessageRow>).message?.customType);
}
function isBranch(component: Component): component is Branch {
  return Array.isArray((component as Partial<Branch>).children);
}
export function toolLabel(name: string): string {
  return name.split(/[.:/]/).pop() || name;
}
function isFileTool(name: string): boolean {
  return ["read", "write", "edit"].includes(toolLabel(name));
}
export function oneLine(value: unknown): string {
  return String(value ?? "").replace(/\t/g, " ").replace(/\r\n?|\n/g, " ↵ ")
    .replace(/[\x00-\x1f\x7f-\x9f]/g, "").trim();
}
function shortPath(value: unknown, cwd?: string): string {
  const path = oneLine(value);
  const base = cwd?.replace(/\/$/, "");
  if (base && path.startsWith(`${base}/`)) return path.slice(base.length + 1);
  const home = homedir();
  return path.startsWith(`${home}/`) ? `~${path.slice(home.length)}` : path;
}
function positiveInteger(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : undefined;
}
function lineSpan(start: number, end = start): string {
  return end > start ? `${start}-${end}` : String(start);
}

/** Read arguments use Pi's usual :start-end notation; no file I/O for ranges. */
export function fileLineRange(name: string, input: unknown, result?: ToolRow["result"]): string {
  const args = input && typeof input === "object" ? input as Record<string, unknown> : {};
  const label = toolLabel(name);
  if (label === "read") {
    const start = positiveInteger(args.offset) ?? 1;
    const limit = positiveInteger(args.limit);
    if (limit) return `:${lineSpan(start, start + limit - 1)}`;
    if (positiveInteger(args.offset)) return `:${start}`;
    if (!result || result.isError) return "";
    const details = result.details as { truncation?: { outputLines?: number; firstLineExceedsLimit?: boolean } } | undefined;
    if (details?.truncation?.firstLineExceedsLimit) return "";
    const outputLines = positiveInteger(details?.truncation?.outputLines);
    const text = result.content?.find(block => block.type === "text")?.text;
    const count = outputLines ?? (text ? text.replace(/\r?\n$/, "").split("\n").length : undefined);
    return count ? `:${lineSpan(start, start + count - 1)}` : "";
  }
  if (label === "write" && typeof args.content === "string" && args.content.length) {
    const count = args.content.replace(/\r?\n$/, "").split("\n").length;
    return `:${lineSpan(1, count)}`;
  }
  if (label === "edit" && result && !result.isError) {
    const details = result.details as { diff?: string; firstChangedLine?: number } | undefined;
    // Pi's display diff numbers additions in the new file and removals in the
    // old file. Keep those coordinate sets separate when they differ.
    const ranges = (sign: "+" | "-") => {
      const numbers = [...new Set((details?.diff ?? "").split("\n")
        .filter(line => line.startsWith(sign))
        .map(line => positiveInteger(Number(line.match(/^[+-]\s*(\d+) /)?.[1])))
        .filter((line): line is number => line !== undefined))].sort((a, b) => a - b);
      const spans: string[] = [];
      for (let index = 0; index < numbers.length; index++) {
        const start = numbers[index];
        let end = start;
        while (numbers[index + 1] === end + 1) end = numbers[++index];
        spans.push(lineSpan(start, end));
      }
      return spans.join(",");
    };
    const added = ranges("+");
    const removed = ranges("-");
    if (added && removed && added !== removed) return `:old ${removed} → new ${added}`;
    if (added || removed) return `:${added || removed}`;
    const first = positiveInteger(details?.firstChangedLine);
    if (first) return `:${first}`;
  }
  return "";
}

export function styleFileSummary(name: string, input: unknown, cwd: string | undefined, result: ToolRow["result"], theme: Theme): string {
  const args = input && typeof input === "object" ? input as Record<string, unknown> : {};
  const path = shortPath(args.path ?? args.file_path ?? args.file, cwd) || "…";
  const split = path.lastIndexOf("/") + 1;
  return theme.fg("muted", path.slice(0, split)) + emphasize(path.slice(split), theme)
    + theme.fg("muted", fileLineRange(name, args, result));
}

export function toolSummary(name: string, input: unknown, cwd?: string, result?: ToolRow["result"]): string {
  const args = input && typeof input === "object" ? input as Record<string, unknown> : {};
  const label = toolLabel(name);
  if (isFileTool(name)) return (shortPath(args.path ?? args.file_path ?? args.file, cwd) || "…") + fileLineRange(name, args, result);
  if (label === "bash" || label === "powershell") return oneLine(args.command) || "…";
  if (label === "codemode") return oneLine(typeof input === "string" ? input : args.code) || "…";
  if (label === "grep" || label === "find") {
    return `${oneLine(args.pattern) || "…"} in ${shortPath(args.path ?? ".", cwd)}`;
  }
  const custom = customToolSummary(name, input, result);
  if (custom !== undefined) return custom;
  // Prefer descriptive arguments, never entire write/edit payloads or stdin.
  for (const key of ["path", "file_path", "command", "question", "title", "query", "url", "goal", "session_name", "status", "name", "reason"]) {
    if (args[key] !== undefined && args[key] !== null) {
      return key.includes("path") ? shortPath(args[key], cwd) : oneLine(args[key]);
    }
  }
  const fields = Object.entries(args)
    .filter(([key, value]) => !/token|secret|password|content|stdin|code|edits/i.test(key)
      && ["string", "number", "boolean"].includes(typeof value))
    .slice(0, 2).map(([key, value]) => `${oneLine(key)}=${oneLine(value)}`);
  return fields.join(" ");
}

/** Instance-local, reversible adapter; native rendering remains untouched off-mode. */
export class CompactView {
  private originals = new Map<Component, { render: Component["render"]; mouse: Component["handleMouse"]; invalidate: Component["invalidate"]; ownRender: boolean; ownMouse: boolean; ownInvalidate: boolean; wrappedInvalidate: boolean }>();
  private positions = new WeakMap<ToolRow, GroupPosition>();
  private groupCache = new WeakMap<Component[], GroupCache>();
  private rowCache = new WeakMap<ToolRow, RenderCache>();
  private messageCache = new WeakMap<AgentMessageRow, RenderCache>();
  private providerCache = new WeakMap<AssistantRow, RenderCache>();
  private nestedRows = new WeakMap<ToolRow, NestedRows>();
  private syntaxCache = new WeakMap<ToolRow, { language: "bash" | "javascript"; command: string; theme: unknown[]; text: string }>();
  private disposed = false;
  public showCode = false;
  public nestedCalls = new Map<string, NestedCall>();

  constructor(private tui: TUI, private getTheme: () => Theme, public enabled = true) {
    // Do not patch the TUI proxy itself: Pi can swap the underlying renderer.
    for (const child of tui.children) this.attach(child);
  }

  private attach(component: Component): void {
    if (this.disposed || this.originals.has(component)) return;
    if (!isToolRow(component) && !isAgentMessage(component) && !isBranch(component)) return;
    const original = {
      render: component.render, mouse: component.handleMouse, invalidate: component.invalidate,
      ownRender: Object.hasOwn(component, "render"), ownMouse: Object.hasOwn(component, "handleMouse"),
      ownInvalidate: Object.hasOwn(component, "invalidate"),
      wrappedInvalidate: isToolRow(component) || isAgentMessage(component) || isAssistantRow(component),
    };
    this.originals.set(component, original);
    if (isAssistantRow(component)) {
      component.invalidate = () => { this.providerCache.delete(component); original.invalidate.call(component); };
      component.render = width => {
        const body = original.render.call(component, width);
        const tools = this.enabled ? this.providerRows(component, width) : [];
        return tools.length ? [...tools, ...body] : body;
      };
      component.handleMouse = event => {
        const offset = this.enabled ? this.providerRows(component, event.width).length : 0;
        return event.y < offset ? undefined : original.mouse?.call(component, { ...event, y: event.y - offset, height: Math.max(0, event.height - offset) });
      };
      return;
    }
    if (isToolRow(component)) {
      component.invalidate = () => { this.rowCache.delete(component); original.invalidate.call(component); };
      component.render = width => this.enabled ? this.renderRow(component, width) : original.render.call(component, width);
      // Let compact text participate in terminal selection, not the native box's
      // stale mouse geometry. Ctrl+O still controls expansion in the normal view.
      component.handleMouse = event => this.enabled ? undefined : original.mouse?.call(component, event);
      return;
    }
    if (isAgentMessage(component)) {
      component.invalidate = () => { this.messageCache.delete(component); original.invalidate.call(component); };
      component.render = width => {
        if (!this.enabled) return original.render.call(component, width);
        if (width <= 0) return [];
        const theme = this.getTheme();
        const key = [width, ...themeKey(theme), component.outputPad, ...messageKey(component.message)];
        const cached = this.messageCache.get(component);
        if (sameKey(cached?.key, key)) return cached!.lines;
        const body = renderCustomMessage(component.message, theme, width, component.outputPad);
        const lines = body ? body.length ? ["", ...body] : [] : original.render.call(component, width);
        this.messageCache.set(component, { key, lines });
        return lines;
      };
      component.handleMouse = event => this.enabled ? undefined : original.mouse?.call(component, event);
      return;
    }
    if (isBranch(component)) {
      for (const child of component.children) this.attach(child);
      component.render = width => {
        for (const child of component.children) this.attach(child);
        if (this.enabled) this.groupRows(component.children, width);
        return original.render.call(component, width);
      };
    }
  }

  private providerRows(row: AssistantRow, width: number): string[] {
    const theme = this.getTheme();
    const key = [width, ...themeKey(theme), row.outputPad, ...providerToolKey(row.lastMessage)];
    const cached = this.providerCache.get(row);
    if (sameKey(cached?.key, key)) return cached!.lines;
    const lines = renderProviderTools(row.lastMessage, theme, width, row.outputPad);
    this.providerCache.set(row, {key, lines});
    return lines;
  }

  private groupRows(children: Component[], width: number): void {
    // Visibility, not just child identity, can change while assistant text streams.
    const key: unknown[] = [width];
    let pending = false;
    for (const child of children) {
      key.push(child);
      if (isToolRow(child)) {
        key.push(child.toolName);
        pending = isFileTool(child.toolName) || isQuestionTool(child.toolName);
      } else if (pending) {
        const visible = isAgentMessage(child) || child.render(width).length > 0;
        key.push(visible);
        if (visible) pending = false;
      }
    }
    const cached = this.groupCache.get(children);
    if (sameKey(cached?.key, key)) {
      // A branch can restore an older child array after the same rows were
      // grouped differently elsewhere (tree/view changes).
      for (const [row, position] of cached!.positions) this.positions.set(row, position);
      return;
    }
    const positions = new Map<ToolRow, GroupPosition>();
    let run: ToolRow[] = [];
    let kind: string | undefined;
    const finish = () => {
      run.forEach((row, index) => positions.set(row, { grouped: run.length > 1, first: index === 0 }));
      run = []; kind = undefined;
    };
    for (const child of children) {
      if (isToolRow(child)) {
        const nextKind = isFileTool(child.toolName) ? child.toolName : isQuestionTool(child.toolName) ? "questions" : undefined;
        if (!nextKind) {
          finish();
          positions.set(child, { grouped: false, first: true });
        } else {
          if (run.length && kind !== nextKind) finish();
          kind = nextKind; run.push(child);
        }
      } else {
        // Tool-only assistant messages render nothing. Do not split a run at
        // those, but never group across visible prose, thinking, or user input.
        if (run.length && (isAgentMessage(child) || child.render(width).length > 0)) finish();
      }
    }
    finish();
    for (const [row, position] of positions) this.positions.set(row, position);
    this.groupCache.set(children, { key, positions });
  }

  private syncNestedRows(parent: ToolRow): ToolRow[] {
    let state = this.nestedRows.get(parent);
    if (!state) { state = { children: [], entries: new Map() }; this.nestedRows.set(parent, state); }
    const details = parent.result?.details as { calls?: { id?: string; name: string; args?: string; status?: string }[] } | undefined;
    const calls = Array.isArray(details?.calls) ? details.calls : [];
    let liveCalls: NestedCall[] | undefined;
    const seen = new Set<string>();
    state.children.length = 0;
    for (const call of calls) {
      if (typeof call?.name !== "string") continue;
      const index = state.children.length;
      const id = call.id ?? `${parent.toolCallId}/preview-${index}`;
      const key = `${index}:${id}`;
      let entry = state.entries.get(key);
      if (!entry) {
        entry = { parsed: false, row: {
          toolName: call.name, toolCallId: id, args: undefined, executionStarted: true, isPartial: false,
          setExpanded() {}, render: () => [], invalidate() {},
        } };
        state.entries.set(key, entry);
      }
      seen.add(key);
      let live = call.id ? this.nestedCalls.get(call.id) : undefined;
      if (!live && call.id?.endsWith("/?")) {
        // Only unresolved previews need the ordered fallback; ordinary frames
        // must not scan every session's nested call for each parent.
        liveCalls ??= [...this.nestedCalls.entries()].filter(([id]) => id.startsWith(`${parent.toolCallId}/`)).map(([, call]) => call);
        if (liveCalls[index]?.name === call.name) live = liveCalls[index];
      }
      if (!live && (!entry.parsed || entry.preview !== call.args)) {
        entry.preview = call.args; entry.parsed = true;
        try { entry.args = JSON.parse(call.args ?? "{}"); } catch { entry.args = { title: call.args ?? "" }; }
      }
      Object.assign(entry.row, {
        toolName: live?.name ?? call.name, toolCallId: id,
        args: live ? live.args : entry.args, cwd: parent.cwd, outputPad: 0,
        isPartial: live?.running ?? call.status === "running",
        result: live?.result ?? (call.status === "error" || call.status === "cancelled" ? NESTED_FAILURE : undefined),
      });
      state.children.push(entry.row);
    }
    for (const key of state.entries.keys()) if (!seen.has(key)) state.entries.delete(key);
    return state.children;
  }

  private renderRow(row: ToolRow, width: number): string[] {
    if (width <= 0) return [];
    const theme = this.getTheme();
    const position = this.positions.get(row) ?? { grouped: false, first: true };
    const nested: string[][] = [];
    if (toolLabel(row.toolName) === "codemode") {
      const children = this.syncNestedRows(row);
      const childWidth = Math.max(1, width - Math.max(0, Math.min(3, row.outputPad ?? 1)) - 2);
      this.groupRows(children, childWidth);
      for (const child of children) nested.push(this.renderRow(child, childWidth));
    }
    const key = [width, ...themeKey(theme), this.showCode, row.cwd, row.toolCallId,
      position.grouped, position.first, ...toolKey({ name: row.toolName, args: row.args, result: row.result,
        isPartial: row.isPartial, executionStarted: row.executionStarted, outputPad: row.outputPad }, this.showCode), ...nested];
    const cached = this.rowCache.get(row);
    if (sameKey(cached?.key, key)) return cached!.lines;
    const lines = this.layoutRow(row, width, theme, position, nested);
    this.rowCache.set(row, { key, lines });
    return lines;
  }

  private layoutRow(row: ToolRow, width: number, theme: Theme, position: GroupPosition, nested: string[][]): string[] {
    const label = toolLabel(row.toolName);
    const custom = renderCustomTool({name: row.toolName, args: row.args, result: row.result,
      isPartial: row.isPartial, executionStarted: row.executionStarted, outputPad: row.outputPad}, theme, width,
      {heading: !position.grouped || position.first});
    if (custom !== undefined) return [...(position.first ? [""] : []), ...custom];
    const title = theme.fg("mdLink", theme.bold(label === "bash" || label === "powershell" ? "$" : oneLine(label)));
    let summary = label === "codemode" && !this.showCode ? "" : isFileTool(row.toolName)
      ? styleFileSummary(row.toolName, row.args, row.cwd, row.result, theme)
      : theme.fg("muted", toolSummary(row.toolName, row.args, row.cwd, row.result));
    const args = row.args && typeof row.args === "object" ? row.args as Record<string, unknown> : {};
    const command = label === "codemode" ? (typeof row.args === "string" ? row.args : args.code) : args.command;
    const language = label === "codemode" ? "javascript" : "bash";
    if ((label === "bash" || (label === "codemode" && this.showCode)) && typeof command === "string" && command.trim()) {
      const key = themeKey(theme);
      let cached = this.syntaxCache.get(row);
      if (!cached || cached.language !== language || cached.command !== command || !sameKey(cached.theme, key)) {
        cached = { language, command, theme: key, text: highlightCompactCode(command, language, theme) };
        this.syntaxCache.set(row, cached);
      }
      summary = cached.text;
    }
    const status = row.result?.isError ? theme.fg("error", " ✗")
      : row.isPartial ? theme.fg("muted", row.executionStarted ? " ⋯" : " …") : "";
    const pad = " ".repeat(Math.max(0, Math.min(3, row.outputPad ?? 1)));
    const lines: string[] = position.first ? [""] : [];
    const fit = (text: string) => truncateToWidth(text, width);
    const withStatus = (text: string) => {
      const suffix = truncateToWidth(status, width, "");
      return truncateToWidth(text, Math.max(0, width - visibleWidth(suffix))) + suffix;
    };
    const inline = `${pad}${title}${summary ? ` ${summary}` : ""}`;
    if (label === "codemode" && (summary.includes("\n") || visibleWidth(inline + status) > width)) {
      lines.push(withStatus(pad + title));
      const indent = pad + "  ";
      const available = width - visibleWidth(indent);
      for (const sourceLine of summary.split("\n")) {
        const wrapped = available > 0 ? wrapTextWithAnsi(sourceLine, available) : [""];
        for (const line of wrapped) lines.push(fit(indent + line));
      }
    } else if (position.grouped) {
      if (position.first) lines.push(fit(pad + title));
      lines.push(withStatus(`${pad}  ${summary}`));
    } else {
      lines.push(withStatus(`${pad}${title}${summary ? ` ${summary}` : ""}`));
    }
    if (nested.length) {
      const indent = pad + "  ";
      nested.forEach(rendered => {
        // Nested headings already have the parent as their visual separator.
        for (const line of rendered.slice(rendered[0] === "" ? 1 : 0)) lines.push(fit(indent + line));
      });
    }
    return lines;
  }

  refresh(): void {
    for (const child of this.tui.children) this.attach(child);
    this.tui.invalidate();
    this.tui.requestRender();
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const [component, original] of this.originals) {
      if (original.ownRender) component.render = original.render;
      else delete (component as Partial<Component>).render;
      if (original.ownMouse) component.handleMouse = original.mouse;
      else delete component.handleMouse;
      if (original.wrappedInvalidate) {
        if (original.ownInvalidate) component.invalidate = original.invalidate;
        else delete (component as Partial<Component>).invalidate;
      }
    }
    this.originals.clear();
    this.rowCache = new WeakMap(); this.messageCache = new WeakMap(); this.providerCache = new WeakMap();
    this.groupCache = new WeakMap(); this.nestedRows = new WeakMap(); this.syntaxCache = new WeakMap();
  }
}
