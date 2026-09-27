# Plan mode

TUI-only project extension. `/reload` to load it.

- `/plan <description>` creates `plans/` if necessary, enters plan mode, and sets the plan file to `plans/<UPPERCASE_UNDERSCORE_DESCRIPTION>.md`. Before each interactive user prompt during plan mode, the extension sends a hidden plan-mode message, followed by the user's prompt. The footer displays the active plan file.
- While planning, **all existing tools stay available**. Prompt instructions tell the model to inspect, ask questions with `ask_question`, and write/edit only the designated plan file until approval; this is guidance, not a hard tool restriction. The plan instructions specify Markdown sections for overview, goals, decisions/tradeoffs, architecture, code changes, and optional obstacles or review needs.
- `/implement` explicitly approves the written plan, leaves plan mode, and sends the agent an implementation request. It requires the plan file to exist.
- `/exit-plan` leaves without approval; a one-time hidden warning message is sent before the next interactive user prompt. The `finish_plan({ approved: boolean })` tool handles both cases when the user explicitly asks the agent to leave planning: `approved: false` exits without approval, while `approved: true` approves a written plan and lets the agent implement it. It is a no-op outside plan mode.

`finish_plan` remains registered and active in every interactive session; plan-mode transitions never change the active tool set. Its stable tool guideline says to call it only when plan mode is active and the user explicitly requests exit or implementation. Plan-mode instructions and the one-time exit warning are conversation messages, not system-prompt changes; the only system-prompt guidance added by this extension is the stable rule not to call `finish_plan` unless the user explicitly requests exit or implementation during plan mode. Plan mode is restored on session resume. No commands, tools, UI, or prompt additions load in headless or RPC mode.

Tests: `node --test .pi/extensions/plan-mode/test.cjs`.
