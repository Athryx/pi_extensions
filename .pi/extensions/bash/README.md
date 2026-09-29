# Async bash tools

Based on `@earendil-works/pi-coding-agent` **0.85.1** (MIT). The `bash` tool overrides Pi's built-in execution while retaining its renderer. Shell settings, command prefix, PI_* session variables, process-tree killing, and output truncation are retained.

- `bash(command, yield_timeout_ms?, session_name?)` waits up to 60 seconds by default (max 5 minutes). If the command is still running, it returns a background session name (`bash1`, `bash2`, … unless named explicitly) and a log path. Names must be unique among active sessions.
- `interact_bash(session_name, stdin?, yield_timeout_ms?)` writes stdin **verbatim** (no automatic newline) and returns only new stdout/stderr since the last read. Default wait is 1 second when sending stdin and 10 seconds otherwise, max 5 minutes. On exit, the session is removed; exit errors are reported.
- `close_bash(session_name)` kills the process tree, returns any output since the last read (with the same truncation limits as `interact_bash`), removes the session and retains its log.

`close_bash` reports the total command runtime and log path in one closing status line; it omits poll wait time.

All three tools reject unknown argument names. For example, `yield_time_ms` produces a validation error; use `yield_timeout_ms`. A `bash` response reports elapsed command time without poll wait time, whether the command finishes or remains running. `interact_bash` also reports the time spent waiting in that call. Running session responses identify the session as running. Only the initial `bash` response explains how to use `interact_bash` and `close_bash`; later polls omit that reminder.

Background sessions append all combined stdout/stderr to a temp log from process start, including output emitted between tool calls. Each response keeps only the last 2000 lines / 50KB of its own output interval; the log retains everything. Foreground commands that finish during the wait discard their log unless their output was truncated or they failed. Session shutdown kills outstanding processes but does not delete their logs. If any background commands are stopped, a model-visible message listing their session names and log paths is saved in the Pi session so the agent knows they cannot be resumed. No message is added when none were stopped. Sessions cannot be resumed after a Pi session switch/reload.
Background sessions append all combined stdout/stderr to a temp log from process start, including output emitted between tool calls. Each response displays up to 2000 lines / 50KB of its own output interval. When that interval is truncated, it shows approximately equal portions from the beginning and end with a middle-omission marker, and places the truncation summary before the log path in the same status line. The log retains everything. Foreground commands that finish during the wait discard their log unless their output was truncated or they failed. Session shutdown kills outstanding processes but does not delete their logs. If any background commands are stopped, a model-visible message listing their session names and log paths is saved in the Pi session so the agent knows they cannot be resumed. No message is added when none were stopped. Sessions cannot be resumed after a Pi session switch/reload.

## Response formats

Each response starts with stdout and stderr received in that call, or `(no new output)`. A truncated response shows the beginning, `... [middle output omitted] ...`, and the end. The truncated examples below assume 2,500 short lines, retaining lines 1–999 and 1501–2500; byte-limited output uses byte sizes in the summary instead.

| Tool result | Without truncation | With truncation |
| --- | --- | --- |
| `bash` exits | `[Command ran for 0.2s.]` | `[Command ran for 0.2s. Showing lines 1-999 and 1501-2500 of 2500. Full output: /tmp/pi-bash-abc.log]` |
| `bash` keeps running | `[Running bash session: bash1. Command elapsed: 60.0s. Full output: /tmp/pi-bash-abc.log. Use interact_bash to send stdin or read new output; close_bash to stop it.]` | `[Running bash session: bash1. Command elapsed: 60.0s. Showing lines 1-999 and 1501-2500 of 2500. Full output: /tmp/pi-bash-abc.log. Use interact_bash to send stdin or read new output; close_bash to stop it.]` |
| `interact_bash` sees exit | `[Command ran for 12.4s; waited: 2.4s this call.]` | `[Command ran for 12.4s; waited: 2.4s this call. Showing lines 1-999 and 1501-2500 of 2500. Full output: /tmp/pi-bash-abc.log]` |
| `interact_bash` keeps running | `[Running bash session: bash1. Command elapsed: 11.0s; waited: 1.0s this call. Full output: /tmp/pi-bash-abc.log.]` | `[Running bash session: bash1. Command elapsed: 11.0s; waited: 1.0s this call. Showing lines 1-999 and 1501-2500 of 2500. Full output: /tmp/pi-bash-abc.log.]` |
| `close_bash` | `[Closed bash session bash1. Command ran for 12.0s. Full output: /tmp/pi-bash-abc.log]` | `[Closed bash session bash1. Command ran for 12.0s. Showing lines 1-999 and 1501-2500 of 2500. Full output: /tmp/pi-bash-abc.log]` |

Times and paths are illustrative. The truncation summary covers only output received in that call; the path points to the complete session log.

Run `node --test .pi/extensions/bash/test.cjs` to smoke-test the tools (requires `pi` on PATH).
