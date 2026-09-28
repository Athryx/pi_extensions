# Goal mode

## Overview

Add a project-local Pi extension that tracks one session goal, exposes goal-management tools and `/goal` commands, and automatically continues a running goal when the agent tries to finish without changing its status. Goal state follows the active session branch; TUI users see a compact current-goal indicator.

## Goals

- Provide `set_goal(goal: string)` to set/replace a nonempty current goal and mark it `running`.
- Provide `set_goal_status(status: "running" | "completed" | "blocked", reason?: string)` with **no separate evidence parameter**. Require an existing goal; `completed` clears the goal string, `blocked` preserves it but pauses automatic continuation, and `running` resumes it. For agent-initiated `completed`/`blocked`, require a substantive `reason` explaining the evidence for that status; allow agent-initiated `running` only to resume an interrupted/blocked goal when the user requests it. Explain these rules in the tool descriptions/system-prompt guidance. Do not invent evidence.
- Register `/goal <goal>` (replace an existing goal and immediately kick off work), `/goal resume`, `/goal pause`, `/goal stop`. Commands are explicit user overrides and need not provide an evidence-based reason. `resume` requires a retained blocked goal; `pause` marks an existing goal blocked; `stop` marks it completed and clears it. Reject missing goals or invalid/empty input with helpful feedback. Consider `/goal` with no arguments a status/help display.
- On a normal final assistant turn with no tool calls while status remains `running`, queue another agent turn reminding it of the exact goal and asking it to check evidence for completed/blocked, call `set_goal_status` if justified, or **keep working**. Continue across final turns until the goal is completed or blocked, rather than imposing a one-reminder limit.
- Surface the current goal and its status (and blocked reason if present) in TUI; remove the indicator on completion; restore it after session reload/resume/tree navigation.
- Make state, tools, prompt guidance and continuation available in TUI, RPC, JSON and print modes, with visual UI guarded by `ctx.hasUI`/`ctx.mode`. Cover interactions and edge cases in tests and document usage.

## Decisions and tradeoffs

- Implement as `.pi/extensions/goal-mode/index.ts`, separate from existing `.pi/extensions/plan-mode/` to avoid coupling goal tracking to plan approval or modifying plan-mode semantics.
- Persist snapshots (goal, status, and optional reason) via `pi.appendEntry()` custom entries and reconstruct from `ctx.sessionManager.getBranch()` on session start and `session_tree`. Use branch state rather than a global file; history remains session-local and survives compaction. Completion persists a snapshot with an empty goal, so it cannot resurrect an older goal.
- Centralize validated state transitions for tools and commands; command transitions intentionally bypass the agent reason requirement because they are direct user instructions. For tool-driven completion/blocking, runtime validation requires a nonempty `reason` that describes the evidence; the extension cannot independently verify its truth, so prompt guidance calls for strong evidence and truthful reporting. The `reason` field is optional in the tool schema (and for `running`), not a separate `evidence` field.
- Use a compact footer status for state plus a truncated goal widget (and reason on blocked) rather than replacing Pi's footer/editor or building a modal. Clear UI on completion and rebuild from state on resume; no visual UI in headless modes.
- The auto-continuation loop has no arbitrary retry limit, per request. It runs only for `running` goals and successful normal final responses; suppress it on errors, aborts, outstanding queued user input/follow-ups, and non-final/tool-use responses. This avoids most runaway loops but a non-cooperating model may continue indefinitely until the user interrupts or pauses it.
- Use per-turn system-prompt guidance (via `before_agent_start` and/or stable tool `promptGuidelines`) to prohibit unsolicited `set_goal` and unsupported status changes, and include the live goal in the continuation reminder. Do not rely on UI state as model context. Keep guidance compatible with other extensions' system-prompt modifications.

## Proposed architecture

1. Represent state as `{ goal: string | null, status: "running" | "blocked" | "completed", reason?: string }`, with invariant `goal !== null` for running/blocked, and `goal === null` after completion. Define one transition function to validate, persist, and render each successful change; replacing a goal resets the reason.
2. Register both tools with TypeBox schemas (use Pi's `StringEnum` for status). Ensure rejected calls return clear tool errors and never mutate state. Commands use the same transitions with a `userCommand` origin, plus immediate `pi.sendUserMessage()` kickoff for `/goal <goal>` and `/goal resume` when idle (or a queued follow-up if busy). Allow pause/stop while busy and ensure any previously queued goal reminder is inert if state changed.
3. Detect the final assistant message using the agent/turn lifecycle (`agent_end` or equivalent after verifying the last assistant message has normal stop reason, no tool calls, and no pending messages). If the same goal is still running, enqueue a hidden custom follow-up with `pi.sendMessage({ customType, content, display: false }, { deliverAs: "followUp", triggerTurn: true })`, containing the exact current goal and instructions to call `set_goal_status` with an evidence-based reason if completed/blocked, or continue working. Re-evaluate at every subsequent normal final answer. Prevent duplicate scheduling for one ending run and avoid injecting on interrupted/error/aborted runs.
4. Restore branch-local state on session start and tree changes; update status/widget from restored state. Use live-state checks when a queued reminder is delivered (or invalidate stale reminders by checking a goal generation/identity) so replacing, pausing, or stopping a goal cannot restart old work. Test actual Pi follow-up delivery semantics before finalizing this mechanism.

## Code changes

- Add `.pi/extensions/goal-mode/index.ts` for tools, command dispatcher, state snapshots, prompt guidance, continuation hook, and UI.
- Add `.pi/extensions/goal-mode/test.cjs` with mocked Pi lifecycle coverage (and smoke-test against Pi if available): set/replace, empty/invalid arguments, mandatory goal, reason validation for tool-driven completion/blocking, direct-command overrides, pause/resume/stop, persistence across reload and branch navigation, normal final/no-tool detection, repeated continuation while running, and no continuation when blocked/completed/aborted/error/pending. Verify commands trigger work immediately and that headless mode doesn't require UI.
- Add `.pi/extensions/goal-mode/README.md` describing commands, tool contracts, semantics, how to interrupt/stop an ongoing goal, persistence, and the potentially unbounded continuation loop. Optionally link the new extension from the repository README.

## Obstacles or review needed

- Pi's `agent_end`/`agent_settled` ordering relative to `followUp` delivery and queued messages should be confirmed during implementation with an integration smoke test. If hidden custom follow-ups cannot trigger repeated agent runs reliably, use Pi's supported `sendUserMessage(..., { deliverAs: "followUp" })` fallback, recognizing that it appears as a user message rather than hidden extension guidance.
- If goal mode and plan mode are enabled together, plan mode's restrictions and approval requirement still take precedence; automatic goal continuation must not be interpreted as permission to implement an unapproved plan.
