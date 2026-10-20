# ui

Interface-only extension. Run `/reload` to load it.

- **Ctrl+C** saves nonempty editor text into Up-arrow prompt history before Pi clears it. Large paste markers are expanded. Nothing is submitted to the agent or added to the conversation. Native clear/exit behavior remains unchanged, and dialogs are unaffected. Also follows a remapped `app.clear` binding.
- **Compact tools** are enabled by default. No colored panels, raw execution output, diffs, or inline images: concise summaries per tool (with full question/answer and agent-message bodies below), with blue/theme-link-colored tool names, slightly emphasized teal file basenames, and muted grey directories, line ranges, arguments, and summaries. Bash shows `$ command` with shell syntax highlighting (strings, variables, keywords, and comments), blended toward muted grey. Bash command names (argv0) use the same muted teal accent, including commands after pipes, `&&`, and semicolons. The display-only lexer skips assignment prefixes, redirection targets, quoted arguments, and comments; it is conservative around heredocs and does not resolve expansions. Multiline commands remain on one display line. In compact view, codemode shows its label with nested tool calls underneath using the same compact styling. Consecutive file calls are grouped, so file paths appear at a second indentation level. Live calls use their full arguments and results for summaries; restored sessions fall back to saved argument previews (truncated previews may lack file ranges). `/ui compact-code` additionally displays the script with subdued JavaScript syntax highlighting, including raw and `{ code }` inputs. Short scripts that fit stay beside the tool name; multiline or longer scripts appear underneath, indented like grouped reads, preserving JavaScript newlines and indentation and wrapping long lines to the terminal width. Highlighting follows the active theme; native collapsed/expanded renderers are unchanged. Consecutive reads, writes, or edits of the same tool are grouped under one heading with indented file paths. One blank line separates tools/groups. Running and failed calls retain a small status marker.
- **Native web search** summaries from `codex-web-search` render at the end of the turn as `searched <phrase>` and `viewed web page <URL>`, with blue/theme-link-colored labels and muted arguments in compact and compact-code modes. Only explicit page-open actions produce page-view rows; search-result and citation URLs do not. Find-in-page actions show `searched web page <URL> · <pattern>`. Structured actions persist for reopened sessions and worker viewing. Legacy mixed-action summaries use a generic `web search` label. Collapsed/expanded modes keep the extension's normal source summary.
- **Line ranges** follow paths: `read a.ts:10-34`, `write a.ts:1-20`, `edit a.ts:5,20-22`. Reads use the requested offset/limit, or returned line count for full reads. Writes use content line count. Edits use changed-line numbers from the result diff; differing old/new spans are labeled, e.g. `a.ts:old 10-11 → new 10-12`. Unknown ranges are omitted; no extra file reads are performed.
- **Ctrl+O** cycles **compact → compact-code → collapsed → expanded → compact** in the main editor, also following a remapped `app.tools.expand` binding. Each key press advances once; Kitty key-release events and held-key repeats do not advance the cycle. Dialog/overlay shortcuts and explicit history bindings retain their native behavior. **Ctrl+Alt+O** remains a direct compact/normal toggle. Commands: `/ui compact`, `/ui compact-code`, `/ui collapsed`, `/ui expanded`, `/ui normal`, `/ui toggle`, `/ui cycle`. Each change uses Pi’s in-conversation `Tool output: <mode>` status notice for all four modes, updating consecutive notices in place. There is no footer mode label. View preference is saved in the session.

Normal view uses Pi's original rendering, including renderers supplied by other extensions. No tool execution, parameters, results, or model context are changed. Non-TUI modes are untouched.

## Compact custom tools and agent messages

Compact and compact-code modes also handle repository tools, including calls nested inside codemode:

- **Questions:** `ask_question` (also recognizing the `ask_questions` spelling in tool rows) uses one `ask_question` heading. Consecutive question calls group under that heading, with indented `question: <full text>` and `answer: <full answer>` rows for each question and separate notes when present. Long text wraps; explicit newlines are preserved. Answers match the question text, not the result array position; repeated identical questions consume answers in occurrence order. Result-only questions are retained. Partial calls show pending, null answers show cancelled, errors show failed, and missing/malformed answers show unavailable rather than invented answers.
- **Creating agents:** `create agent <name> · template: <template or default>` is followed by the full indented, wrapped task (or legacy prompt).
- **Sending and receiving messages:** `send message to <agent_name>` and `receive message from <sender>` show the complete indented body, preserving newlines and wrapping to the terminal width. Received `subagents.message.v1` custom messages use their envelope metadata; older entries can fall back to `Message from <name>:\n<body>` content. Other custom message types keep their native renderer. Compact received messages have no panel.
- **Operational summaries:** goal tools show the goal or status and reason; `finish_plan` shows approval; `wait_message` shows timeout and a received-sender acknowledgment, not a duplicate message body. `list_agents` shows scope. Bash-session tools show the session and whether input is sent or output polled, without exposing stdin.

These are display-only adapters: arguments, results, message metadata, and model context remain unchanged. Terminal control sequences in custom text are stripped. Switching to collapsed/expanded (normal) rendering restores the original tool and custom-message renderers.

## Rendering performance

Pi's working spinner redraws about 12.5 times per second, including while waiting for the model. Compact rows cache their complete rendered lines (summaries, custom bodies, wrapping, truncation, and nested layout), and received messages and viewed-session banners cache their output too. Group positions, parsed nested argument previews, stable nested rows, syntax highlighting, and theme/color palettes are reused. Hidden codemode scripts are not highlighted.

Cache keys track displayed content, including in-place streaming mutations, width, theme/color mode, padding, group positions, and tool-view mode. Explicit component invalidation clears rendered output, and cleanup restores native instance methods. Caches are weakly held with one current layout per row/theme; nested records removed from a parent are discarded. Spinner frames do not serialize complete arguments/results or redo expensive text layout for unchanged history.

## Read-only viewed sessions

Other extensions can temporarily show another session in Pi's native transcript, without changing the active session, model context, main transcript, or prompt history. `/subagents` uses this for worker views. Live assistant text, tool arguments, partial results, and nested calls update in place; stored/idle history can be displayed without starting an agent. Native worker tool renderers are used when its live session is available.

The main editor stays focused, but ordinary submissions and model/session actions are blocked while viewing. **Escape** or **Ctrl+C** returns to the main transcript without clearing its draft or aborting its agent. **Alt+] / Alt+[** cycle workspace agent views via the subagents extension; its persistent row below the prompt highlights the viewed agent. **Ctrl+O**, **Ctrl+Alt+O**, `/ui`, and `/subagents` remain available; dialogs keep their own controls. The viewed banner reports the current tool mode and warnings for blocked controls, without appending warnings to the main transcript. Held Kitty Escape/Ctrl+C repeat reports cannot clear or interrupt main after returning; a new key press resumes native behavior. Other footer/header widgets and main-session status remain attached to the main session, not the viewed worker. Viewing is not a session switch or a way to send prompts to a worker.

### Extension API

Import the shared contract from `../shared/viewed-session` in a neighboring extension. Discovery is synchronous; request it again after reload rather than caching the old service.

```ts
import { requestViewedSessionAPI } from "../shared/viewed-session";

// Inside a command handler. The worker/history owner supplies the source.
const api = requestViewedSessionAPI(pi);
const source = {
  id: worker.id,
  title: worker.title,
  getSnapshot: () => ({
    messages: worker.messages,
    session: worker.session, // optional; native worker renderers/settings
    // manager and settings are also optional for stored history.
    toolUpdates: worker.toolUpdates, // optional Map keyed by toolCallId
  }),
  subscribe: (changed: () => void) => worker.subscribe(changed),
};
if (!api?.available || !api.setViewedSession(source)) {
  // Fall back to your existing transcript overlay.
}
const unsubscribe = api?.onChange(view => {
  // view is { id, title }, or undefined when the main transcript is restored.
});
// Later: api?.getViewedSession(); api?.setViewedSession(undefined);
// Remove your own observer during cleanup: unsubscribe?.();
```

Version 1 exposes `available`, `setViewedSession(source | undefined): boolean`, `getViewedSession()`, and `onChange(listener): unsubscribe`. A source must return `{ messages, session?, manager?, settings?, toolUpdates? }` without starting/resuming an agent and return an unsubscribe function from `subscribe`. Notify subscribers after replacing messages/tool updates. The UI releases its source subscription on replacement, exit, reload, session reset, or shutdown. `tool_execution_update` snapshots use `partialResult`; retained nested start/end snapshots allow full arguments and result-derived summaries.

## Compatibility

Pi has no public transcript grouping/spacing API. `compact.ts` therefore wraps component **instances**, not global prototypes, and recognizes Pi's `ToolExecutionComponent` and `CustomMessageComponent` runtime fields. The Ctrl+C and tool-cycle listener uses the main `CustomEditor`'s action map/keybindings to distinguish editor actions from dialog/overlay input. The tool-cycle action (including repeat reports) is consumed before Pi's two-state toggle runs. Raw listeners run before Pi's key-release filtering, so this extension explicitly ignores release reports. All wrappers/listeners are removed on reload/shutdown. A future Pi change to these internals may require updating the adapter; unrecognized components keep their normal rendering. Other main editors work if they preserve CustomEditor's action map and history interface.

The viewed-session adapter additionally recognizes the installed Pi layout: seven root containers (document, pending, status, widgets-above, editor, widgets-below, footer), with header/resources/chat inside the document. Only the document's chat child is swapped; the original main chat stays alive and is restored on exit, including in fullscreen's native scroll viewport. Unsupported layouts/non-TUI modes report `available: false` and reject a new source without mutating the tree. Consumers should keep their old overlay fallback when the service is absent or rejects the view. Alternate editors or future Pi layouts may need an adapter update.

Tests against the installed Pi host (no paid or external model calls). The host smoke test initializes the real `InteractiveMode` and SDK runtime with an injected terminal and deterministic in-process worker provider; it covers `/subagents demo`, live updates, read-only controls, and the production fullscreen switch:

```sh
node --test pi/extensions/ui/*.test.cjs
```
