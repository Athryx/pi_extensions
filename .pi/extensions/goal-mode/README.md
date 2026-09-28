# Goal mode

Project-local Pi extension (load with `/reload`). Tracks one goal per session branch in TUI, RPC, JSON, and print modes. The TUI shows the status in the footer and a short goal widget above the editor.

- `/goal <goal>` sets or replaces the goal, marks it running, and immediately asks the agent to work on it.
- `/goal` shows the current goal in UI modes.
- `/goal pause` marks the goal blocked without clearing it; `/goal resume` marks a blocked goal running and resumes work; `/goal stop` marks it completed and clears it. These are direct user commands, so they do not require an evidence-based reason.
- `set_goal({ goal })` sets or replaces a goal. The agent should only call it when the user explicitly asks to set a goal.
- `set_goal_status({ status, reason? })` requires an existing goal. Agent calls with `completed` or `blocked` require a nonempty reason describing strong evidence for that status (there is **no separate evidence field**). `completed` clears the goal; `blocked` retains it and stops automatic continuation. Agent calls with `running` are for user-requested resumption of blocked goals only.

While a goal is running, every normally completed agent run ending in a final response without tool calls triggers another hidden follow-up. The follow-up asks the agent to report completion/blockage with an evidence-based reason or **keep working**. This can run indefinitely if the agent does not finish or block the goal: use `/goal pause`, `/goal stop`, or interrupt the agent to regain control. Errors, aborts, tool-use responses, and queued user input do not trigger a follow-up. Pausing/stopping/replacing a goal invalidates old reminder content. State is saved as branch-local custom entries and restored on session resume/reload/tree navigation.

Goal mode does not grant permission to bypass plan mode. If both are active, the plan-mode approval and file-change restrictions still apply.

Tests: `node --test .pi/extensions/goal-mode/test.cjs`.
