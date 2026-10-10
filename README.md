Personal pi extensions

Compatible with Pi 1.1.0 (`@earendil-works/pi-coding-agent`). Run `/reload` after changing extensions.

- [`context`](.pi/extensions/context/README.md): `/context` opens a split-pane browser for prompts, tool schemas, conversation context, and estimated token usage.

All model-facing tools reject unknown argument names. Pi reports a validation error with the received arguments before running the tool.

Run unit tests and compatibility checks against the currently installed `pi`:

```sh
node --test .pi/extensions/*/test.cjs tests/pi-compatibility.cjs
```
