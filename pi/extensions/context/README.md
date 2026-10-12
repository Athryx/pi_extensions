# Context browser

Run `/reload`, then `/context` to open a themed context inspector. This extension adds one command and no tools or model instructions.

The left pane is an expandable, scrollable tree; the right pane shows the selected entry's full text. Categories include:

- **System prompt** and its named sections (rules, project instructions, skills, extension instructions, etc.).
- **Tool definitions**, including descriptions and complete JSON parameter schemas for active, declared tools.
- **Conversation**, with user messages, assistant text/thinking/tool calls, tool results, injected messages, shell executions, and compaction/branch summaries.

Each entry/category shows estimated tokens. The detail pane also shows its share of the view's total. The header separately shows Pi's own context usage and window size, when available.

## Controls

| Control | Action |
| --- | --- |
| Up/Down | Select entries, or scroll content when the right pane is focused |
| Enter | Expand/collapse a group, or focus a leaf's content |
| Tab / Shift+Tab | Switch panes |
| Right / Left | Expand or focus content / collapse or return to the tree |
| PageUp/PageDown | Navigate/scroll by a page |
| Home/End | First/last entry or start/end of content |
| `r` | Toggle current context / last captured request, when available |
| Escape / `q` | Close |

List actions honor Pi's configured `tui.select.*` keybindings. In fullscreen mode, click entries to select and expand them, and use the wheel over either pane. Regular terminal mode uses keyboard controls because the terminal owns mouse input. Below 72 columns, only the focused pane is shown; Tab switches between list and content.

## What is being measured?

**Current effective context** combines `ctx.getSystemPrompt()`, registered active tool schemas (excluding hidden declarations), and Pi's finalized session projection. That projection respects the active branch, compaction, context edits, and excluded `!!` shell commands. Abandoned history and UI-only extension state are not counted. It is a snapshot taken when the command opens, not a live view; reopen to refresh.

**Last captured request** is an in-memory copy observed at this extension's `context_with_system` hook. It includes prompt/tool deltas and request-time changes already made by earlier handlers. Later handlers, forced-prompt projection, hidden-declaration projection, and provider serialization can still change what is ultimately sent. Current registry descriptions can also differ from descriptions rewritten by `prepareLoadout`; the captured transcript is preferable for inspecting those. No request is available until a model call has occurred since loading the extension. The copy is cleared on session/branch changes, compaction, shutdown, and reload.

Per-entry counts are estimates, **not exact tokenizer counts**: Pi's characters/4 heuristic for text and tool-call arguments, compact JSON/4 for tool declarations, and approximately 1,200 tokens per image. Message framing, provider-specific transformations, and opaque thinking/text signatures are not included. Aggregating rounded estimates can differ slightly from estimating the combined text, and the totals will not necessarily match Pi's usage. The last-request view retains system updates; the current view shows the effective, folded prompt/tool state.

Image attachments show their MIME type and encoded size, not their base64 payload. Terminal escape sequences are stripped from displayed content. The inspector does not modify the session, write context to disk, capture credentials/headers, or call a model. Custom terminal UI is only available in interactive TUI mode.

## Tests

```sh
node --test .pi/extensions/context/test.cjs tests/pi-compatibility.cjs
```

Tests use the installed Pi loader, session projection, token estimator, key parser, scrolling component, and terminal-width utilities.
