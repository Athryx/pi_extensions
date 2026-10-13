All pi extensions should be developed in pi/extensions. Existing ones are:
- `bash`: replaces default pi bash tool; allows background sessions and interaction
- `ask-question`: provides ask_question tool
- `goal-mode`: sets agent running on long term goal with no expected user interaction
- `plan-mode`: command to tall agent to make a plan
- `context`: command to show conversation context
- `codex-usage`: shows current usage if using a codex model
- `ui`: alternate convesation ui modes, and ability to show different sessions
- `subagents`: persistent workers, same-group messaging, `/groups` and read-only `/subagents` viewing
- `workflow`: directed JS-file orchestration with local agent definitions and scoped sequence/parallel progress

The `skills/dynamic-workflows/SKILL.md` skill documents workflow usage; its `examples/research.js` is read-only and self-contained. **Do not use workflow unless directed** by the user or configured agent instructions. Each `workflow.agent` creates an isolated headless group root; ordinary children stay in the creator's group. Models cannot list/message across groups. A leaf group root has no create/list/send/wait agent tools; selecting `workflow` is independent. `/groups` is human viewer navigation, not a model permission change. These are in-process tool policies, not OS isolation. `max_depth` limits ordinary child-agent depth within each group (roots at 0); `max_group_depth` limits agent-group nesting (workspace root at 0, workflow containers do not count). Both default to 4. `max_running` remains workspace-wide.

Setup commands (from this repository root):

```sh
npm --prefix pi/extensions/subagents ci --ignore-scripts --legacy-peer-deps
npm --prefix pi/extensions/workflow ci --ignore-scripts --legacy-peer-deps
```

Pi supplies host peer dependencies; do not install duplicate host SDK copies. Initial workflow dependency/lockfile setup uses `npm --prefix pi/extensions/workflow install --ignore-scripts --legacy-peer-deps`.

Optional skill-manager setup is documentation for the user, not an automatic implementation step: `manage-skills add /home/jack/projects/pi_extensions/skills/dynamic-workflows`, then `manage-skills sync --agent pi`. Adjust the checkout path if needed. A session can instead use `pi --skill ./skills/dynamic-workflows`, or a template can use `skills.extra_paths`. Do not modify global configuration or skill-manager state just to test this skill.

Verification (deterministic providers; no paid model calls):

```sh
npm --prefix pi/extensions/workflow test
npm --prefix pi/extensions/workflow run check
npm --prefix pi/extensions/subagents test
npm --prefix pi/extensions/subagents run check
node --test pi/extensions/*/test.cjs pi/extensions/*/*.test.cjs tests/*.cjs
git diff --check
```

New pi extension tools developed should default to throwing an error if extra fields are submitted, unless otherwise stated.

directories in pi are symlinked to paths in global ~/.pi/agents, so changing them and reloading works.

Pi's working spinner requests a UI redraw every 80 ms (about 12.5 frames/second), even while waiting for a model. For future UI work, consider caching all expensive render work: finished rows, wrapping/truncation, syntax highlighting, grouping, nested-call argument parsing, and theme/color calculations. Unchanged history should reuse cached output, not be recomputed on every spinner frame. Invalidate caches for content/streaming updates (including in-place mutations), width, theme/color mode, grouping, and view changes; keep caches bounded or weakly held. Add regression tests for both cache reuse and invalidation.
