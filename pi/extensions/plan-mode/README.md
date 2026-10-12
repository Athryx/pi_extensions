# Plan mode

Main-TUI-only project extension. Run `/reload` to load it. The finish_plan tool is marked interactive-only using the shared helper: workers and headless/RPC sessions receive no tool guidance, cannot call it, and do not activate planning controls or inject plan instructions.

## Commands

All planning controls are unified under `/plan`:

- `/plan`: Enters plan mode for the upcoming task without fixing a filename upfront. Creates `plans/` if needed. The prompt instructs the model to create `plans/<plan_name>.md` using a short phrase describing the task. The status bar displays `PLAN: active`.
- `/plan <name>` (e.g. `/plan auth_flow.md` or `/plan auth_flow`): Enters plan mode and places the file under `plans/` (e.g. `plans/auth_flow.md`).
- `/plan <path>` (contains `/` or `\\`, e.g. `/plan docs/design.md`): Enters plan mode with an explicit file path. Creates parent directories if missing.
- `/plan <description>` (multi-word prompt, e.g. `/plan improve search`): Enters plan mode and normalizes the description into an uppercase slug in `plans/` (e.g. `plans/IMPROVE_SEARCH.md`).
- `/plan implement` (or `/plan approve`): Explicitly approves the drafted plan, exits plan mode, and sends the agent an implementation request. If no plan file was specified upfront, it automatically discovers the most recently modified `.md` plan in `plans/`.
- `/plan exit`: Leaves plan mode without approval. A one-time hidden warning message is sent before the next interactive user prompt so the model does not implement the plan without approval.
- `/plan status`: Reports whether plan mode is active and the active plan target.

## Model Guidance & Antigravity Alignment

Before each interactive user prompt during plan mode, the extension injects a hidden instructions message closely matching Google Antigravity's plan mode:

- **Read-only exploration**: All tools remain available for inspection and research; the only permitted file change before approval is writing or revising the plan.
- **Clarification**: Prompt instructs using `ask_question` (or direct questions) to clarify ambiguities and missing requirements.
- **Structured Plan Document**:
  - `## [Goal Description]`: Problem overview and background.
  - `## User Review Required`: Critical items, breaking changes, design decisions using GitHub alerts (`> [!IMPORTANT]`, `> [!WARNING]`, `> [!CAUTION]`).
  - `## Open Questions`: Clarifying questions affecting implementation.
  - `## Proposed Changes`: Grouped by component with explicit code snippets, diffs, and markers (`#### [MODIFY]`, `#### [NEW]`, `#### [DELETE]`).
  - `## Verification Plan`: Automated tests (`### Automated Tests`) and manual steps (`### Manual Verification`).
- **Walkthrough Document**: After implementation and verification, the model creates or updates `plans/walkthrough.md` summarizing changes, tests run, and validation results.

## Divergences from Antigravity

1. **Filesystem vs Artifact System**: Antigravity writes plans and walkthroughs into an internal artifact database (`<Artifact Directory>/<plan_name>.md`). Pi has no artifact system; plans and walkthroughs are standard Markdown files stored in the repository (`plans/` by default).
2. **Persistent Session Mode vs Ephemeral Turn Trigger**: Antigravity applies plan instructions on the specific turn `/plan` is invoked. Pi maintains a persistent state machine (`project-plan-mode`) with TUI status indicators (`PLAN: <file>`) and pre-prompt instruction injections until explicitly approved or exited.
3. **Approval Mechanism**: Antigravity provides an interactive UI modal button ("Proceed"). Pi provides `/plan implement` and the model-callable `finish_plan({ approved: true })` tool.
4. **Exiting**: Antigravity has no exit command. Pi provides `/plan exit` (and `finish_plan({ approved: false })`) with a follow-up warning notice to prevent unintended plan implementation.
5. **Command Palette**: Antigravity only provides `/plan` as a prompt prefix. Pi unifies planning management under `/plan` with subcommands (`/plan implement`, `/plan exit`, `/plan status`).

## Tests

Run unit tests:
```sh
node --test .pi/extensions/plan-mode/test.cjs
```
