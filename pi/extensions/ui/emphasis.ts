import type { Theme } from "@earendil-works/pi-coding-agent";
import { foregroundAnsi, mixColors, okhslColor } from "@earendil-works/pi-tui";
import { sameKey, themeKey } from "./render-cache.js";

const cache = new WeakMap<Theme, { key: unknown[]; ansi: string }>();

/** A restrained teal, distinct from both grey summaries and blue tool labels. */
export function emphasisAnsi(theme: Theme): string {
  const key = themeKey(theme);
  const cached = cache.get(theme);
  if (sameKey(cached?.key, key)) return cached!.ansi;
  const teal = okhslColor(185, 0.5, theme.appearance === "dark" ? 0.7 : 0.4);
  const ansi = foregroundAnsi(mixColors(theme.colors.muted, teal, 0.72), theme.getColorMode());
  cache.set(theme, { key, ansi });
  return ansi;
}
export function emphasize(text: string, theme: Theme): string {
  return emphasisAnsi(theme) + text + "\x1b[39m";
}
