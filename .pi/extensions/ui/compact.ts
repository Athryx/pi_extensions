import { homedir } from "node:os";
import type { Theme } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth, wrapTextWithAnsi, type Component, type TUI } from "@earendil-works/pi-tui";
import { highlightCompactCode } from "./syntax-highlight.js";
import { emphasize } from "./emphasis.js";

// Pi exposes renderers, but no transcript-layout hook. Keep the only internal
// dependency here: the runtime fields on ToolExecutionComponent. Never replace
// tool definitions, prototypes, transcript entries, or another tool's renderer.
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
interface GroupPosition {
  grouped: boolean;
  first: boolean;
}

function isToolRow(component: Component): component is ToolRow {
  const row = component as Partial<ToolRow>;
  return typeof row.toolName === "string" && typeof row.toolCallId === "string"
    && "args" in row && typeof row.setExpanded === "function"
    && typeof row.executionStarted === "boolean" && typeof row.isPartial === "boolean";
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
  private originals = new Map<Component, { render: Component["render"]; mouse: Component["handleMouse"]; ownRender: boolean; ownMouse: boolean }>();
  private positions = new WeakMap<ToolRow, GroupPosition>();
  private syntaxCache = new WeakMap<ToolRow, { language: "bash" | "javascript"; command: string; colors: Theme["colors"]; mode: ReturnType<Theme["getColorMode"]>; text: string }>();
  private disposed = false;
  public showCode = false;
  public nestedCalls = new Map<string, { name: string; args: unknown; result?: ToolRow["result"]; running: boolean }>();

  constructor(private tui: TUI, private getTheme: () => Theme, public enabled = true) {
    // Do not patch the TUI proxy itself: Pi can swap the underlying renderer.
    for (const child of tui.children) this.attach(child);
  }

  private attach(component: Component): void {
    if (this.disposed || this.originals.has(component)) return;
    if (!isToolRow(component) && !isBranch(component)) return;
    const original = {
      render: component.render, mouse: component.handleMouse,
      ownRender: Object.hasOwn(component, "render"), ownMouse: Object.hasOwn(component, "handleMouse"),
    };
    this.originals.set(component, original);
    if (isToolRow(component)) {
      component.render = width => this.enabled ? this.renderRow(component, width) : original.render.call(component, width);
      // Let compact text participate in terminal selection, not the native box's
      // stale mouse geometry. Ctrl+O still controls expansion in the normal view.
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

  private groupRows(children: Component[], width: number): void {
    let run: ToolRow[] = [];
    const finish = () => {
      run.forEach((row, index) => this.positions.set(row, { grouped: run.length > 1, first: index === 0 }));
      run = [];
    };
    for (const child of children) {
      if (isToolRow(child)) {
        if (!isFileTool(child.toolName)) {
          finish();
          this.positions.set(child, { grouped: false, first: true });
        } else {
          if (run.length && run[0].toolName !== child.toolName) finish();
          run.push(child);
        }
      } else {
        // Tool-only assistant messages render nothing. Do not split a run at
        // those, but never group across visible prose, thinking, or user input.
        if (run.length && child.render(width).length > 0) finish();
      }
    }
    finish();
  }

  private renderRow(row: ToolRow, width: number): string[] {
    if (width <= 0) return [];
    const theme = this.getTheme();
    const position = this.positions.get(row) ?? { grouped: false, first: true };
    const label = toolLabel(row.toolName);
    const title = theme.fg("mdLink", theme.bold(label === "bash" || label === "powershell" ? "$" : oneLine(label)));
    let summary = isFileTool(row.toolName)
      ? styleFileSummary(row.toolName, row.args, row.cwd, row.result, theme)
      : theme.fg("muted", toolSummary(row.toolName, row.args, row.cwd, row.result));
    const args = row.args && typeof row.args === "object" ? row.args as Record<string, unknown> : {};
    const command = label === "codemode" ? (typeof row.args === "string" ? row.args : args.code) : args.command;
    const language = label === "codemode" ? "javascript" : "bash";
    if ((label === "bash" || label === "codemode") && typeof command === "string" && command.trim()) {
      const colors = theme.colors;
      const mode = theme.getColorMode();
      let cached = this.syntaxCache.get(row);
      if (!cached || cached.language !== language || cached.command !== command || cached.colors !== colors || cached.mode !== mode) {
        cached = { language, command, colors, mode, text: highlightCompactCode(command, language, theme) };
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
    if (label === "codemode" && !this.showCode) summary = "";
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
    if (label === "codemode") {
      const details = row.result?.details as { calls?: { id?: string; name: string; args?: string; status?: string }[] } | undefined;
      const calls = Array.isArray(details?.calls) ? details.calls : [];
      const liveCalls = [...this.nestedCalls.entries()].filter(([id]) => id.startsWith(`${row.toolCallId}/`)).map(([, call]) => call);
      const children: ToolRow[] = calls.filter(call => typeof call?.name === "string").map((call, index) => {
        const live = (call.id ? this.nestedCalls.get(call.id) : undefined)
          ?? (call.id?.endsWith("/?") && liveCalls[index]?.name === call.name ? liveCalls[index] : undefined);
        let args: unknown = live?.args;
        if (!live) {
          try { args = JSON.parse(call.args ?? "{}"); } catch { args = { title: call.args ?? "" }; }
        }
        const child: ToolRow = {
          toolName: live?.name ?? call.name, toolCallId: call.id ?? `${row.toolCallId}/preview-${index}`,
          args, cwd: row.cwd, outputPad: 0, executionStarted: true,
          isPartial: live?.running ?? call.status === "running",
          result: live?.result ?? (call.status === "error" || call.status === "cancelled" ? { isError: true } : undefined),
          setExpanded() {}, render: () => [], invalidate() {},
        };
        return child;
      });
      this.groupRows(children, Math.max(1, width - visibleWidth(pad) - 2));
      const indent = pad + "  ";
      children.forEach(child => {
        const rendered = this.renderRow(child, Math.max(1, width - visibleWidth(indent)));
        // Nested headings already have the parent as their visual separator.
        for (const line of rendered.filter(line => line !== "")) lines.push(fit(indent + line));
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
    }
    this.originals.clear();
  }
}
