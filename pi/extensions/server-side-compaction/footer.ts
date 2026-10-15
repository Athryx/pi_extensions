import { FooterComponent } from "@earendil-works/pi-coding-agent";
import { visibleWidth, type Component, type TUI } from "@earendil-works/pi-tui";

export function compactionLabel(backend: "pi" | "server", mode: string): string {
  return `${backend} compaction (${mode === "auto" ? "auto" : "override"})`;
}

/** Preserve the native footer and other adapters; use only its model-row padding. */
export class CompactionFooter {
  private originals = new Map<Component, { render: Component["render"]; own: boolean; wrapper: Component["render"] }>();
  private disposed = false;
  constructor(private tui: TUI, private getText: () => string) { this.attach(); }

  attach(): void {
    // Once found, the native footer is stable for this session. Do not walk
    // unchanged conversation history again on every 80ms spinner frame.
    if (this.disposed || this.originals.size) return;
    const visit = (component: Component) => {
      if (component instanceof FooterComponent && !this.originals.has(component)) {
        const render = component.render, own = Object.hasOwn(component, "render");
        let cachedLine: string | undefined, cachedText: string | undefined, cachedWidth = 0, cachedResult: string | undefined;
        const wrapper = (width: number): string[] => {
          const lines = render.call(component, width);
          if (this.disposed || lines.length < 2) return lines;
          const line = lines[1], suffix = this.getText();
          if (line !== cachedLine || suffix !== cachedText || width !== cachedWidth) {
            cachedLine = line; cachedText = suffix; cachedWidth = width;
            cachedResult = line;
            const columns = visibleWidth(suffix);
            const gap = / {2,}/.exec(line);
            // Hide on narrow terminals instead of truncating stats or model.
            if (suffix && gap && gap[0].length >= columns + 2 && visibleWidth(line) <= width) {
              cachedResult = line.slice(0, gap.index) + gap[0].slice(columns) + line.slice(gap.index + gap[0].length) + suffix;
            }
          }
          const result = [...lines];
          result[1] = cachedResult!;
          return result;
        };
        this.originals.set(component, { render, own, wrapper });
        component.render = wrapper;
      }
      const children = (component as Component & { children?: Component[] }).children;
      if (Array.isArray(children)) children.forEach(visit);
    };
    this.tui.children.forEach(visit);
  }

  refresh(): void { if (!this.disposed) this.tui.requestRender(); }
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const [component, original] of this.originals) {
      if (component.render !== original.wrapper) continue;
      if (original.own) component.render = original.render;
      else delete (component as Partial<Component>).render;
    }
    this.originals.clear();
  }
}
