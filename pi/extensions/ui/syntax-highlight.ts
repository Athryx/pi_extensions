import { highlightCode, type Theme } from "@earendil-works/pi-coding-agent";
import { foregroundAnsi, mixColors } from "@earendil-works/pi-tui";
import { emphasisAnsi } from "./emphasis.js";
import { accentCommandNames, shellCommandSpans } from "./shell-command-spans.js";
import { sameKey, themeKey } from "./render-cache.js";

const palettes = new WeakMap<Theme, { key: unknown[]; muted: string; replacements: Map<string, string> }>();
function palette(theme: Theme) {
  const key = themeKey(theme);
  const cached = palettes.get(theme);
  if (sameKey(cached?.key, key)) return cached!;
  const muted = theme.getFgAnsi("muted");
  const replacements = new Map<string, string>();
  const foreground = (token: Parameters<Theme["getFgAnsi"]>[0]) => theme.getFgAnsi(token).match(/\x1b\[[\d;]*m/)?.[0];
  const textColor = foreground("text");
  if (textColor) replacements.set(textColor, muted);
  for (const token of ["syntaxKeyword", "syntaxType", "syntaxNumber", "syntaxString", "syntaxComment", "syntaxFunction", "syntaxVariable", "syntaxOperator", "syntaxPunctuation"] as const) {
    const source = foreground(token);
    if (source && !replacements.has(source)) {
      replacements.set(source, foregroundAnsi(mixColors(theme.colors.muted, theme.colors[token], 0.45), theme.getColorMode()));
    }
  }
  // Restore muted foreground after syntax spans reset their own styling.
  for (const reset of ["\x1b[39m", "\x1b[22;39m", "\x1b[0m"]) replacements.set(reset, reset + muted);
  const result = { key, muted, replacements };
  palettes.set(theme, result);
  return result;
}

/** Preserve JavaScript lines, flatten Bash, and subdue syntax colors. */
export function highlightCompactCode(command: string, language: "bash" | "javascript", theme: Theme): string {
  // Preserve newlines until after parsing (otherwise a comment would consume
  // the next command). Never allow command text to inject terminal escapes.
  const sanitized = command.replace(/\r\n?/g, "\n").replace(/\t/g, " ")
    .replace(/[\x00-\x09\x0b-\x1f\x7f-\x9f]/g, "");
  const safe = language === "bash" ? sanitized.trim() : sanitized.trimEnd();
  const plain = language === "bash" ? safe.replace(/\n/g, " ↵ ") : safe;
  if (!safe || safe.length > 16_000) return theme.fg("muted", plain);

  const { muted, replacements } = palette(theme);
  try {
    const highlighted = highlightCode(safe, language).join("\n");
    const subdued = muted + highlighted.replace(/\x1b\[[\d;]*m/g, ansi => replacements.get(ansi) ?? ansi);
    const accented = language === "bash"
      ? accentCommandNames(subdued, shellCommandSpans(safe), emphasisAnsi(theme)) : subdued;
    return (language === "bash" ? accented.replace(/\n/g, " ↵ ") : accented) + "\x1b[22;39m";
  } catch {
    return theme.fg("muted", plain);
  }
}
