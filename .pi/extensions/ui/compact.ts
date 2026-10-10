import { homedir } from "node:os";
import type { Theme } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth, type Component, type TUI } from "@earendil-works/pi-tui";

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
  return String(value ?? "").replace(/\r\n?|\n/g, " ↵ ")
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

export function toolSummary(name: string, input: unknown, cwd?: string, result?: ToolRow["result"]): string {
  const args = input && typeof input === "object" ? input as Record<string, unknown> : {};
  const label = toolLabel(name);
  if (isFileTool(name)) return (shortPath(args.path ?? args.file_path ?? args.file, cwd) || "…") + fileLineRange(name, args, result);
  if (label === "bash" || label === "powershell") return oneLine(args.command) || "…";
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
  private disposed = false;

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
    const summary = theme.fg("muted", toolSummary(row.toolName, row.args, row.cwd, row.result));
    const status = row.result?.isError ? theme.fg("error", " ✗")
      : row.isPartial ? theme.fg("muted", row.executionStarted ? " ⋯" : " …") : "";
    const pad = " ".repeat(Math.max(0, Math.min(3, row.outputPad ?? 1)));
    const lines: string[] = position.first ? [""] : [];
    const fit = (text: string) => truncateToWidth(text, width);
    const withStatus = (text: string) => {
      const suffix = truncateToWidth(status, width, "");
      return truncateToWidth(text, Math.max(0, width - visibleWidth(suffix))) + suffix;
    };
    if (position.grouped) {
      if (position.first) lines.push(fit(pad + title));
      lines.push(withStatus(`${pad}  ${summary}`));
    } else {
      lines.push(withStatus(`${pad}${title}${summary ? ` ${summary}` : ""}`));
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
