export interface CommandSpan { start: number; end: number }

// Display-only lexer, never shell execution or expansion. Keep quoted arguments,
// escapes, and expansions together so their contents cannot look like commands.
function quoteEnd(text: string, start: number): number {
  const quote = text[start];
  let index = start + 1;
  while (index < text.length) {
    if (text[index] === "\\" && quote !== "'") { index += 2; continue; }
    if (text[index] === quote) return index + 1;
    if (quote === '"' && text[index] === "$" && /[({]/.test(text[index + 1] ?? "")) {
      index = groupEnd(text, index + 1);
      continue;
    }
    index++;
  }
  return text.length;
}
function groupEnd(text: string, start: number): number {
  const closers = [text[start] === "(" ? ")" : "}"];
  let index = start + 1;
  while (index < text.length && closers.length) {
    const char = text[index];
    if (char === "\\") { index += 2; continue; }
    if (char === "'" || char === '"' || char === "`") { index = quoteEnd(text, index); continue; }
    if (char === "(" || char === "{") closers.push(char === "(" ? ")" : "}");
    else if (char === closers.at(-1)) closers.pop();
    index++;
  }
  return Math.min(index, text.length);
}
function wordEnd(text: string, start: number): number {
  let index = start;
  while (index < text.length) {
    const char = text[index];
    if (char === "\\") { index += Math.min(2, text.length - index); continue; }
    if (char === "'" || char === '"' || char === "`") { index = quoteEnd(text, index); continue; }
    if (char === "$" && /[({]/.test(text[index + 1] ?? "")) { index = groupEnd(text, index + 1); continue; }
    if (/[\s;&|()<>]/.test(char)) break;
    index++;
  }
  return index;
}

/** Best-effort argv0 positions for simple commands, pipelines, and command lists. */
export function shellCommandSpans(text: string): CommandSpan[] {
  const spans: CommandSpan[] = [];
  let index = 0;
  let commandStart = true;
  let redirectTarget = false;
  let loopHeader = false;
  while (index < text.length) {
    const char = text[index];
    if (char === "\\" && text[index + 1] === "\n") { index += 2; continue; }
    if (text.startsWith("((", index) || text.startsWith("[[", index)) {
      index = text.startsWith("((", index) ? groupEnd(text, index) : (text.indexOf("]]", index + 2) === -1 ? text.length : text.indexOf("]]", index + 2) + 2);
      commandStart = false;
      continue;
    }
    if (char === "\n" || /[;&|()]/.test(char)) {
      commandStart = true;
      redirectTarget = false;
      index++;
      continue;
    }
    if (/\s/.test(char)) { index++; continue; }
    if (char === "#") {
      const newline = text.indexOf("\n", index);
      index = newline === -1 ? text.length : newline;
      continue;
    }
    const redirection = /^(?:\d+)?(?:<<<|<<-?|>>?|<>|<&|>&|<)/.exec(text.slice(index));
    if (redirection) {
      // Heredoc bodies are not shell commands. Stop conservatively instead of
      // giving arbitrary data argv0 coloring; syntax highlighting still runs.
      if (redirection[0].includes("<<") && !redirection[0].includes("<<<")) break;
      redirectTarget = true;
      index += redirection[0].length;
      continue;
    }
    const start = index;
    index = wordEnd(text, start);
    if (index === start) { index++; continue; }
    const word = text.slice(start, index);
    if (redirectTarget) { redirectTarget = false; continue; }
    if (word === "do") { loopHeader = false; commandStart = true; continue; }
    if (loopHeader) continue;
    if (!commandStart) continue;
    if (["if", "then", "elif", "else", "while", "until", "!", "{"].includes(word)) continue;
    if (["for", "select", "case", "function", "[[", "(("].includes(word)) {
      loopHeader = word === "for" || word === "select";
      commandStart = false;
      continue;
    }
    if (["fi", "done", "esac", "}", "]]"].includes(word)) { commandStart = false; continue; }
    if (/^[a-zA-Z_][a-zA-Z0-9_]*(?:\[[^\]]*\])?\+?=/.test(word)) continue;
    // Function definitions name a function but do not run it at this point.
    if (/^\s*\(\s*\)/.test(text.slice(index))) { commandStart = false; continue; }
    spans.push({ start, end: index });
    commandStart = false;
  }
  return spans;
}

/** Override foreground only in argv0 spans, retaining the syntax style afterward. */
export function accentCommandNames(styled: string, spans: CommandSpan[], accent: string): string {
  let offset = 0;
  let spanIndex = 0;
  let foreground = "\x1b[39m";
  let faint = false;
  let output = "";
  // Offsets are source-string indices, not terminal columns. The highlighter
  // preserves the source text, including wide characters and newlines.
  for (const part of styled.match(/\x1b\[[\d;]*m|[^\x1b]+/g) ?? []) {
    if (part.startsWith("\x1b[")) {
      const codes = part.slice(2, -1).split(";").map(Number);
      if (codes[0] === 38 || codes[0] === 39 || (codes[0] >= 30 && codes[0] <= 37) || (codes[0] >= 90 && codes[0] <= 97)) foreground = part;
      if (codes[0] === 0) { foreground = "\x1b[39m"; faint = false; }
      if (codes[0] !== 38) {
        if (codes.includes(39)) foreground = "\x1b[39m";
        if (codes.includes(2)) faint = true;
        if (codes.includes(22)) faint = false;
      }
      output += part;
      continue;
    }
    let local = 0;
    while (local < part.length) {
      while (spanIndex < spans.length && spans[spanIndex].end <= offset) spanIndex++;
      const span = spans[spanIndex];
      const active = span && offset >= span.start && offset < span.end;
      const boundary = span ? (active ? span.end : span.start) : Infinity;
      const count = Math.min(part.length - local, boundary - offset);
      const text = part.slice(local, local + count);
      output += active ? `\x1b[22m${accent}${text}${foreground}${faint ? "\x1b[2m" : ""}` : text;
      local += count;
      offset += count;
    }
  }
  return output;
}
