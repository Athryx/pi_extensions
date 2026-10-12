Personal pi extensions

Compatible with Pi 1.1.0 (`@earendil-works/pi-coding-agent`). Run `/reload` after changing extensions.

- [`context`](.pi/extensions/context/README.md): `/context` opens a split-pane browser for prompts, tool schemas, conversation context, and estimated token usage.
- [`subagents`](.pi/extensions/subagents/README.md): YAML agent templates, persistent named workers, asynchronous messaging, `/agent` selection, and a read-only live `/agents` viewer. Install its local dependencies with `npm --prefix .pi/extensions/subagents ci --ignore-scripts --legacy-peer-deps` before reloading.

All model-facing tools reject unknown argument names. Pi reports a validation error with the received arguments before running the tool.

Run unit tests and compatibility checks against the currently installed `pi`:

```sh
node --test .pi/extensions/*/test.cjs .pi/extensions/*/*.test.cjs tests/pi-compatibility.cjs
npm --prefix .pi/extensions/subagents run check
```
