import type { Theme } from "@earendil-works/pi-coding-agent";
import { Text, type Component } from "@earendil-works/pi-tui";
import { clean } from "./output.ts";

/** One cached component per displayed message; scalar keys also detect in-place updates. */
export class SearchSummary implements Component {
  private key?: unknown[];
  private lines: string[] = [];
  constructor(private readonly content: () => string, private readonly expanded: () => boolean, private readonly theme: Theme, private readonly padding: number) {}
  render(width: number): string[] {
    if (width <= 0) return [];
    const content = this.content(), expanded = this.expanded();
    const key = [content, expanded, width, this.padding, this.theme.colors, this.theme.getColorMode(), this.theme.appearance];
    if (this.key?.every((value, index) => Object.is(value, key[index]))) return this.lines;
    this.key = key;
    const text = clean(content);
    const rows = text.split("\n");
    const visible = expanded || rows.length < 4 ? rows : [...rows.slice(0, 3), `… ${rows.length - 3} more lines (expand to view)`];
    this.lines = new Text(this.theme.fg("muted", visible.join("\n")), this.padding, 0).render(width);
    return this.lines;
  }
  invalidate(): void { this.key = undefined; }
}
