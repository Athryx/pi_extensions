import { FooterComponent } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, type Component, type TUI } from "@earendil-works/pi-tui";

/** Reversible instance-only adapter, matching the project's UI adapter pattern. */
export class UsageFooter {
  private originals = new Map<Component, { render: Component["render"]; own: boolean; wrapper: Component["render"] }>();
  private disposed = false;
  constructor(private tui: TUI, private getText: () => string) { this.attach(); }

  attach(): void {
    if (this.disposed) return;
    const visit = (component: Component) => {
      if (component instanceof FooterComponent && !this.originals.has(component)) {
        const render = component.render;
        const own = Object.hasOwn(component, "render");
        const wrapper = (width: number): string[] => {
          const lines = render.call(component, width);
          // Another extension may retain this wrapper after we detach it.
          if (this.disposed) return lines;
          const text = this.getText();
          if (!text || lines.length < 2) return lines;
          // Never mutate another renderer's potentially cached output.
          return [...lines.slice(0, 2), truncateToWidth(text, width, "…"), ...lines.slice(2)];
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
