import type { Theme } from "@earendil-works/pi-coding-agent";
import {
  Key, matchesKey, ScrollView, stripTerminalSequences, truncateToWidth, visibleWidth, wrapTextWithAnsi,
  type Component, type KeybindingsManager, type TUI, type TuiMouseEvent, type TuiMouseEventResult,
} from "@earendil-works/pi-tui";
import type { ContextNode, ContextSnapshot } from "./model";

interface TreeRow { node: ContextNode; depth: number; parent?: string }

export function safeText(text: string): string {
  return stripTerminalSequences(text).replace(/\r\n/g, "\n").replace(/\t/g, "    ")
    .replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f]/g, "");
}

function count(tokens: number): string {
  return tokens >= 10_000 ? `${(tokens / 1000).toFixed(1)}k` : tokens.toLocaleString();
}

/** ScrollView supplies bounded scroll state; explicit clipping works in both TUI modes. */
class Pane {
  readonly scroll: ScrollView;
  constructor(component: Component, private tui: TUI, private theme: Theme) {
    this.scroll = new ScrollView(component, { overscroll: "contain", scrollbar: "hidden" });
  }
  render(width: number, height: number): string[] {
    const content = this.scroll.render(Math.max(1, width - 1));
    this.scroll.updateLayout(content.length, height, () => this.tui.requestRender());
    const top = this.scroll.scrollTop;
    const max = Math.max(0, content.length - height);
    const thumbHeight = Math.max(1, Math.floor(height * height / Math.max(height, content.length)));
    const thumbTop = max ? Math.round(top / max * (height - thumbHeight)) : 0;
    return Array.from({ length: height }, (_, i) => {
      const text = truncateToWidth(content[top + i] ?? "", Math.max(0, width - 1), "…", true);
      const scrollbar = max ? this.theme.fg(i >= thumbTop && i < thumbTop + thumbHeight ? "accent" : "dim", "│") : " ";
      return truncateToWidth(text + scrollbar, width, "", true);
    });
  }
}

export class ContextView implements Component {
  private sourceIndex = 0;
  private selectedId = "system";
  private expanded = new Set(["system", "tools", "conversation"]);
  private focus: "tree" | "detail" = "tree";
  private rows: TreeRow[] = [];
  private bodyHeight = 1;
  private leftWidth = 0;
  private split = true;
  private readonly tree: Pane;
  private readonly detail: Pane;
  private detailCache?: { node: ContextNode; width: number; lines: string[] };

  constructor(
    private snapshots: ContextSnapshot[],
    private tui: TUI,
    private theme: Theme,
    private keybindings: KeybindingsManager,
    private done: () => void,
  ) {
    this.tree = new Pane({ render: width => this.renderTree(width), invalidate() {} }, tui, theme);
    this.detail = new Pane({ render: width => this.renderDetail(width), invalidate: () => { this.detailCache = undefined; } }, tui, theme);
    this.rebuildRows();
  }

  private get snapshot(): ContextSnapshot { return this.snapshots[this.sourceIndex]; }
  private get selectedIndex(): number { return Math.max(0, this.rows.findIndex(row => row.node.id === this.selectedId)); }
  private get selected(): ContextNode { return this.rows[this.selectedIndex].node; }

  private rebuildRows(): void {
    this.rows = [];
    const visit = (nodes: ContextNode[], depth: number, parent?: string) => {
      for (const node of nodes) {
        this.rows.push({ node, depth, parent });
        if (this.expanded.has(node.id)) visit(node.children, depth + 1, node.id);
      }
    };
    visit(this.snapshot.roots, 0);
    if (!this.rows.some(row => row.node.id === this.selectedId)) this.selectedId = this.rows[0].node.id;
  }

  private select(index: number): void {
    const row = this.rows[Math.max(0, Math.min(this.rows.length - 1, index))];
    if (row.node.id !== this.selectedId) {
      this.selectedId = row.node.id;
      this.detailCache = undefined;
      this.detail.scroll.scrollToStart();
    }
    this.ensureVisible();
  }

  private ensureVisible(): void {
    const index = this.selectedIndex;
    if (index < this.tree.scroll.scrollTop) this.tree.scroll.scrollTo(index);
    else if (index >= this.tree.scroll.scrollTop + this.bodyHeight) this.tree.scroll.scrollTo(index - this.bodyHeight + 1);
  }

  private toggle(): void {
    if (!this.selected.children.length) { this.focus = "detail"; return; }
    if (this.expanded.has(this.selectedId)) this.expanded.delete(this.selectedId);
    else this.expanded.add(this.selectedId);
    this.rebuildRows();
    this.tree.scroll.updateLayout(this.rows.length, this.bodyHeight, () => this.tui.requestRender());
    this.ensureVisible();
  }

  private renderTree(width: number): string[] {
    return this.rows.map(({ node, depth }) => {
      const prefix = `${"  ".repeat(depth)}${node.children.length ? (this.expanded.has(node.id) ? "▾" : "▸") : "·"} `;
      const suffix = ` ~${count(node.tokens)}`;
      const label = safeText(node.label).replace(/\n/g, " ");
      const text = truncateToWidth(prefix + label, Math.max(0, width - visibleWidth(suffix)), "…", true) + suffix;
      const padded = truncateToWidth(text, width, "…", true);
      if (node.id === this.selectedId) return this.theme.bg("selectedBg", this.theme.fg("accent", padded));
      return this.theme.fg(depth === 0 ? "accent" : "text", padded);
    });
  }

  private renderDetail(width: number): string[] {
    const node = this.selected;
    if (this.detailCache?.node === node && this.detailCache.width === width) return this.detailCache.lines;
    const percent = this.snapshot.tokens ? (100 * node.tokens / this.snapshot.tokens).toFixed(1) : "0.0";
    const header = `${safeText(node.label)}\n~${node.tokens.toLocaleString()} tokens · ${percent}% of this view${node.children.length ? ` · ${node.children.length} entries` : ""}`;
    const help = this.snapshot.roots.includes(node)
      ? `\n\n${this.snapshot.note}\n\nEstimates use Pi's characters/4 heuristic; images use ~1,200 tokens each. They exclude provider framing and opaque signatures, and are not exact tokenizer counts.\n` : "";
    const lines = [
      ...wrapTextWithAnsi(header, width).map(line => this.theme.fg("accent", line)),
      "",
      ...wrapTextWithAnsi(safeText(node.text) + help, width).map(line => this.theme.fg("text", line)),
    ];
    this.detailCache = { node, width, lines };
    return lines;
  }

  render(width: number): string[] {
    if (width < 1) return [];
    const terminalHeight = Math.max(1, this.tui.terminal.rows);
    if (width < 20 || terminalHeight < 12) {
      return ["Context", "Enlarge terminal to browse", "Esc / q close"].slice(0, terminalHeight)
        .map(line => truncateToWidth(line, width, "…"));
    }
    this.split = width >= 72;
    this.bodyHeight = Math.max(1, terminalHeight - 11);
    const inner = width - 2;
    this.leftWidth = this.split ? Math.min(52, Math.max(28, Math.floor(inner * 0.35))) : inner;
    const rightWidth = this.split ? inner - this.leftWidth - 1 : inner;
    this.tree.scroll.updateLayout(this.rows.length, this.bodyHeight, () => this.tui.requestRender());
    this.ensureVisible();
    const left = this.tree.render(this.leftWidth, this.bodyHeight);
    const right = this.detail.render(rightWidth, this.bodyHeight);
    const border = (text: string) => this.theme.fg("border", text);
    const fit = (text: string, size = inner) => truncateToWidth(text, size, "…", true);
    const row = (text: string) => border("│") + fit(text) + border("│");
    const usage = this.snapshot.usage;
    const piUsage = usage?.tokens == null ? "Pi usage: unknown" : `Pi usage: ${count(usage.tokens)}${usage.contextWindow ? ` / ${count(usage.contextWindow)} (${usage.percent?.toFixed(1) ?? "?"}%)` : ""}`;
    const treeTitle = this.theme.fg(this.focus === "tree" ? "accent" : "muted", " Entries · estimated tokens");
    const detailTitle = this.theme.fg(this.focus === "detail" ? "accent" : "muted", " Content");
    const lines = [
      border(`╭${"─".repeat(inner)}╮`),
      row(this.theme.fg("accent", ` Context · ${this.snapshot.source} · ${this.snapshot.model}`)),
      row(this.theme.fg("muted", ` ${piUsage}  |  View estimate: ~${count(this.snapshot.tokens)}`)),
      border(`├${"─".repeat(inner)}┤`),
      row(this.split ? fit(treeTitle, this.leftWidth) + border("│") + fit(detailTitle, rightWidth)
        : this.focus === "tree" ? treeTitle : detailTitle),
    ];
    for (let i = 0; i < this.bodyHeight; i++) {
      lines.push(row(this.split ? left[i] + border("│") + right[i] : this.focus === "tree" ? left[i] : right[i]));
    }
    lines.push(
      border(`├${"─".repeat(inner)}┤`),
      row(this.theme.fg("muted", " ↑↓ navigate/scroll · Enter expand/view · Tab pane · PgUp/PgDn · Home/End")),
      row(this.theme.fg("muted", ` ${this.snapshots.length > 1 ? "r current/last request · " : ""}← back · Esc/q close · ${this.focus === "tree" ? "Entries" : "Content"} focused`)),
      border(`╰${"─".repeat(inner)}╯`),
    );
    return lines;
  }

  handleInput(data: string): void {
    const action = (name: "tui.select.cancel" | "tui.select.confirm" | "tui.select.up" | "tui.select.down" | "tui.select.pageUp" | "tui.select.pageDown") => this.keybindings.matches(data, name);
    if (action("tui.select.cancel") || matchesKey(data, Key.escape) || matchesKey(data, "q")) { this.done(); return; }
    if (matchesKey(data, "r") && this.snapshots.length > 1) {
      this.sourceIndex = (this.sourceIndex + 1) % this.snapshots.length;
      this.selectedId = "system";
      this.expanded = new Set(["system", "tools", "conversation"]);
      this.rebuildRows();
      this.tree.scroll.scrollToStart();
      this.detail.scroll.scrollToStart();
      this.detailCache = undefined;
    } else if (matchesKey(data, Key.tab) || matchesKey(data, Key.shift("tab"))) {
      this.focus = this.focus === "tree" ? "detail" : "tree";
    } else if (matchesKey(data, Key.left)) {
      if (this.focus === "detail") this.focus = "tree";
      else if (this.expanded.has(this.selectedId) && this.selected.children.length) this.toggle();
      else {
        const parent = this.rows[this.selectedIndex].parent;
        if (parent) this.select(this.rows.findIndex(row => row.node.id === parent));
      }
    } else if (matchesKey(data, Key.right)) {
      if (this.focus === "tree" && this.selected.children.length && !this.expanded.has(this.selectedId)) this.toggle();
      else this.focus = "detail";
    } else if (action("tui.select.confirm") || matchesKey(data, Key.enter)) {
      if (this.focus === "tree") this.toggle();
    } else {
      let delta = 0;
      if (action("tui.select.up") || matchesKey(data, "k")) delta = -1;
      else if (action("tui.select.down") || matchesKey(data, "j")) delta = 1;
      else if (action("tui.select.pageUp")) delta = -Math.max(1, this.bodyHeight - 1);
      else if (action("tui.select.pageDown")) delta = Math.max(1, this.bodyHeight - 1);
      if (delta) {
        if (this.focus === "tree") this.select(this.selectedIndex + delta);
        else this.detail.scroll.scrollBy(delta);
      } else if (matchesKey(data, Key.home) || matchesKey(data, Key.end)) {
        const end = matchesKey(data, Key.end);
        if (this.focus === "tree") this.select(end ? this.rows.length - 1 : 0);
        else if (end) this.detail.scroll.scrollToEnd();
        else this.detail.scroll.scrollToStart();
      }
    }
    this.tui.requestRender();
  }

  handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
    if (event.y < 5 || event.y >= 5 + this.bodyHeight || event.x < 1 || event.x >= event.width - 1) return undefined;
    const pane = this.split ? event.x <= this.leftWidth ? "tree" : "detail" : this.focus;
    if (event.type === "wheel") {
      this.focus = pane;
      if (pane === "detail") this.detail.scroll.scrollBy(event.wheelDelta ?? 0);
      else {
        this.tree.scroll.scrollBy(event.wheelDelta ?? 0);
        // Keep the selection within the new viewport, without snapping the wheel back.
        const top = this.tree.scroll.scrollTop;
        this.select(Math.max(top, Math.min(top + this.bodyHeight - 1, this.selectedIndex)));
      }
    } else if (event.type === "click" && event.button === "left") {
      this.focus = pane;
      if (pane === "tree") {
        const index = this.tree.scroll.scrollTop + event.y - 5;
        if (index >= this.rows.length) return { handled: true };
        this.select(index);
        if (this.selected.children.length) this.toggle();
        else if (!this.split) this.focus = "detail";
      }
    } else return undefined;
    this.tui.requestRender();
    return { handled: true, focus: true };
  }

  invalidate(): void {
    this.detailCache = undefined;
    this.tree.scroll.invalidate();
    this.detail.scroll.invalidate();
  }
}
