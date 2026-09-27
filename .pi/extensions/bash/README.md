# Bash tool baseline

Vendored from `@earendil-works/pi-coding-agent` **0.85.1** (`src/core/tools/bash.ts` and its execution helpers; MIT). The `bash` tool is registered under its original name, overriding Pi's built-in implementation.

- `tool.ts`: schema, process execution, streaming, timeout/abort, result formatting and session environment.
- `shell.ts`, `child-process.ts`: shell selection, environment and process lifecycle.
- `output-accumulator.ts`, `truncate.ts`: streaming output retention and truncation.
- `index.ts`: extension entry point; applies effective shell settings when the session starts.

Execution does **not** call Pi's bash tool. The TUI still inherits Pi's built-in bash renderer (which uses the same result shape), rather than copying presentation code.
