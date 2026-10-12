import type { Theme } from "@earendil-works/pi-coding-agent";
import { highlightCompactCode } from "./syntax-highlight.js";

export function highlightBashCommand(command: string, theme: Theme): string {
  return highlightCompactCode(command, "bash", theme);
}
