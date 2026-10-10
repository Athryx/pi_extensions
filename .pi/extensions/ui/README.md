# ui

Interface-only extension. Run `/reload` to load it.

- **Ctrl+C** saves nonempty editor text into Up-arrow prompt history before Pi clears it. Large paste markers are expanded. Nothing is submitted to the agent or added to the conversation. Native clear/exit behavior remains unchanged, and dialogs are unaffected. Also follows a remapped `app.clear` binding.
- **Compact tools** are enabled by default. No colored panels, output, diffs, or inline images: one summary line per tool, with blue/theme-link-colored names and muted grey paths, commands, and summaries. Bash shows `$ command`. Consecutive reads, writes, or edits of the same tool are grouped under one heading with indented file paths. One blank line separates tools/groups. Running and failed calls retain a small status marker.
- **Line ranges** follow paths: `read a.ts:10-34`, `write a.ts:1-20`, `edit a.ts:5,20-22`. Reads use the requested offset/limit, or returned line count for full reads. Writes use content line count. Edits use changed-line numbers from the result diff; differing old/new spans are labeled, e.g. `a.ts:old 10-11 → new 10-12`. Unknown ranges are omitted; no extra file reads are performed.
- **Ctrl+O** cycles **compact → collapsed → expanded → compact** in the main editor, also following a remapped `app.tools.expand` binding. Dialog/overlay shortcuts and explicit history bindings retain their native behavior. **Ctrl+Alt+O** remains a direct compact/normal toggle. Commands: `/ui compact`, `/ui collapsed`, `/ui expanded`, `/ui normal`, `/ui toggle`, `/ui cycle`. View preference is saved in the session.

Normal view uses Pi's original rendering, including renderers supplied by other extensions. No tool execution, parameters, results, or model context are changed. Non-TUI modes are untouched.

## Compatibility

Pi has no public transcript grouping/spacing API. `compact.ts` therefore wraps component **instances**, not global prototypes, and recognizes Pi's `ToolExecutionComponent` runtime fields. The Ctrl+C and tool-cycle listener uses the main `CustomEditor`'s action map/keybindings to distinguish editor actions from dialog/overlay input. The tool-cycle action is consumed before Pi's two-state toggle runs. All wrappers/listeners are removed on reload/shutdown. A future Pi change to these internals may require updating the adapter; unrecognized components keep their normal rendering. Other main editors work if they preserve CustomEditor's action map and history interface.

Tests against the installed Pi host:

```sh
node --test .pi/extensions/ui/ui.test.cjs
```
