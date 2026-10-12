import type { Theme } from "@earendil-works/pi-coding-agent";
import { foregroundAnsi, mixColors, okhslColor } from "@earendil-works/pi-tui";

/** A restrained teal, distinct from both grey summaries and blue tool labels. */
export function emphasisAnsi(theme: Theme): string {
  const teal = okhslColor(185, 0.5, theme.appearance === "dark" ? 0.7 : 0.4);
  return foregroundAnsi(mixColors(theme.colors.muted, teal, 0.72), theme.getColorMode());
}
export function emphasize(text: string, theme: Theme): string {
  return emphasisAnsi(theme) + text + "\x1b[39m";
}
