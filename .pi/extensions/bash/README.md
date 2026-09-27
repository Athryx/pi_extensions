# Async bash tools

Based on `@earendil-works/pi-coding-agent` **0.85.1** (MIT). The `bash` tool overrides Pi's built-in execution while retaining its renderer. Shell settings, command prefix, PI_* session variables, process-tree killing, and output truncation are retained.

- `bash(command, yield_timeout_ms?, session_name?)` waits up to 10 seconds by default (max 5 minutes). If the command is still running, it returns a background session name (`bash1`, `bash2`, … unless named explicitly) and a log path. Names must be unique among active sessions.
- `interact_bash(session_name, stdin?, yield_timeout_ms?)` writes stdin **verbatim** (no automatic newline) and returns only new stdout/stderr since the last read. Default wait is 1 second when sending stdin and 10 seconds otherwise, max 5 minutes. On exit, the session is removed; exit errors are reported.
- `close_bash(session_name)` kills the process tree, removes the session and retains its log.

Background sessions append all combined stdout/stderr to a temp log from process start, including output emitted between tool calls. Each response keeps only the last 2000 lines / 50KB of its own output interval; the log retains everything. Foreground commands that finish during the wait discard their log unless their output was truncated or they failed. Session shutdown kills outstanding processes but does not delete their logs. Sessions cannot be resumed after a Pi session switch/reload.

Run `node --test .pi/extensions/bash/test.cjs` to smoke-test the tools (requires `pi` on PATH).
