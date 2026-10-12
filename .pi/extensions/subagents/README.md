# Subagents

A named multi-agent workspace for Pi 1.1.0. The CLI remains the interactive `main` agent. Background agents have independent conversations/session files, parent links, restricted loadouts, and asynchronous communications.

## Setup

From the repository root:

```sh
npm --prefix .pi/extensions/subagents ci --ignore-scripts --legacy-peer-deps
```

Pi supplies the peer packages; `--legacy-peer-deps` prevents npm from installing duplicate host copies locally. Reload Pi after installation. The only runtime dependency is `yaml`; TypeScript and Node typings are development dependencies.

Commands:

- `/agent [template]`: select the main conversation's template by name, or open Pi's native picker. Main must be idle and the session must not yet contain an actual user message. You can freely change templates before the first prompt; `/agent` commands, system messages, extension state, and custom context messages do not count. After the first user message, the template is locked: UI modes warn without opening a picker; modes without UI report an error. Use `/new` for an empty conversation where you can choose again. The command preserves the instance name, role, and existing children.
- `/subagents [name]`: with the UI extension's viewed-session API, choose any workspace agent (including idle workers) using Pi's native selector, or view a named agent directly. `/subagents main` restores the main transcript. Worker views are **read-only**, remain live when workers become idle or resume, and use the UI's normal transcript rendering/scrolling. Selection never switches the actual Pi session or grants interactive control to workers; root navigation, reload and shutdown clear it. In print mode this lists workspace members; RPC uses a notification and JSON uses a custom message, regardless of arguments.

In TUI mode an always-visible, wrapping row below the prompt lists every workspace agent as `● name (template)`. The dot is green for starting/running/waiting agents and grey for idle/error/interrupted agents; the viewed agent is highlighted (main when no worker is viewed). **Alt+]** / **Alt+[** cycle forward/backward through all agents, including main and idle workers. **Escape** returns to main. These shortcuts require the UI extension's viewed-session API; `/subagents` keeps its native picker and overlay fallback.

Without a compatible viewed-session UI API, `/subagents` retains the full-screen read-only overlay. Overlay keys: Tab/Shift+Tab or left/right cycle agents; up/down, PageUp/PageDown and Home/End scroll; End follows streaming output; `i` includes idle/error/interrupted agents; `o` expands tool output; Escape or `q` returns to main. Mouse wheel scrolls the selected transcript. Selected workers remain visible when they become idle. Images from tool results honor the session's Pi settings; user image attachments currently show their accompanying text only.

## YAML definitions

Put direct `.yaml`/`.yml` files in `<agent-dir>/agents/` (normally `~/.pi/agent/agents/`) or trusted `<cwd>/.pi/agents/`:

```yaml
name: reviewer
selectable: true
model:
  name: parent
  thinking: parent
tools:
  include_defaults: true
  extra: [grep, find, ls]
skills:
  include_defaults: true
  extra_paths: [./review-skills]
prompt: |
  Review your assigned change and report findings with evidence.
subagents:
  include_defaults: false
  extra: [subagent]
  default: subagent
```

All sections except `name` are optional. Unknown fields, duplicate YAML keys, unsupported tags, multiple documents, invalid references, and excessive alias expansion are rejected. Templates/tasks/messages are limited to 128 KiB. Names are case-sensitive, start with a letter, and contain up to 64 letters, digits, underscores or hyphens.

`selectable` defaults to true. False hides a template from the `/agent` picker and completions only; explicit `/agent name`, child permissions, and `/subagents` workspace views are unaffected.

### Models

`model.name`: `parent`, `global`, or exact `provider/model-id` (model IDs may contain slashes). `model.thinking`: `parent`, `global`, or Pi's `off|minimal|low|medium|high|xhigh|max` levels. Omitted, null, or empty values inherit independently.

`global` means the user's main-session model/thinking selection, not the saved startup default. Applying an explicit `/agent` template does not overwrite the global choice. Main's `parent` falls back to global. Workers resolve at creation and again on idle resume; running workers do not follow mid-turn changes. Pi clamps unsupported thinking levels.

### Tools, skills and child permissions

`tools.include_defaults: true` uses Pi's resolved `defaultTools`: global `<agent-dir>/settings.json` merged with trusted `<cwd>/.pi/settings.json`, including Pi's `+tool`/`-tool` modifier behavior. When unset, Pi's standard read/bash/edit/write selection is used; an explicit empty array selects none. Workers do not inherit the parent's active tools or CLI overrides. Defaults are resolved when a worker runtime is created (including reconstruction after reload), not continuously during a run.

Explicit `tools.extra` names are added to that selection, and send_message/wait_message/list_agents are always retained. With the enhanced bash extension loaded, interact_bash/close_bash are retained only when default bash is selected. `include_defaults: false` ignores `defaultTools` and keeps only explicit extras plus workspace communications. Interactive-only tools are filtered even when named in defaults or extras.

`create_agent` is unreachable unless the template allows child templates. Explicit creation must use an allowed template; omitting the template requires a configured default, never the first allowlist element. Empty `subagents` means a leaf agent. `subagents.include_defaults` defaults to false to preserve leaf behavior; true allows all valid discovered templates (bundled, user/project agents folders, and configured extra paths), including non-selectable templates. `subagents.extra` adds template names, not paths. `default` must name an allowed template. Legacy `subagents.allowed: [...]` remains supported but cannot be combined with `include_defaults` or `extra`.

Extra tool names must exist. Explicit `mcp__...` names get a bounded 10-second startup window for asynchronous registration; unavailable names still fail preflight. Initial unselected extension registrations are hidden; immutable SDK selection and a tool-call guard enforce restrictions on direct/nested calls, including late registrations. This is a tool policy, **not an OS sandbox**. Configured extensions still execute code with Pi's privileges.

`skills.include_defaults` defaults to true and includes normal Pi skill discovery. False makes worker catalogs extra-path-only. Relative skill paths resolve from the YAML file. This does not copy the parent's transcript or already-read skill bodies. On main, skill filtering changes the model's advertised catalog; it cannot erase earlier context, remove all `/skill:` commands, or prevent reads through allowed tools.

The bundled `main` and `subagent` templates differ only in child permissions: main allows/defaults to subagent; subagent is a leaf. The bundled main preserves your existing main-session tools. Custom main templates narrow the general-purpose loadout while retaining tools for enabled interactive workflows such as plan/goal/question mode.

## Configuration and precedence

Optional `<agent-dir>/subagents.json` and trusted `<cwd>/.pi/subagents.json`:

```json
{
  "agent_paths": ["./extra-agents"],
  "max_running": 8,
  "max_depth": 4,
  "worker_exclude_extensions": []
}
```

Paths resolve from their owning configuration directory; absolute paths and `~` work. `worker_exclude_extensions` uses exact extension paths. Project scalar limits override user limits. Waiting workers reserve running capacity.

Precedence, lowest to highest:

1. Bundled definitions.
2. User agents directory.
3. User extra paths in declaration order.
4. Trusted current-project `.pi/agents`.
5. Trusted project extra paths.

Later locations override by template name. Duplicates within one location and malformed named overrides are quarantined, not silently replaced with older permissive definitions. Definitions naming missing child templates are also quarantined. Discovery is non-recursive and does not search ancestor projects. Run `/reload` to refresh definitions; idle workers use the refreshed template on their next resume.

Pi has **no generic custom resource-type API**: these are extension-owned files, not new `settings.json` or package-manifest keys. Package agent directories need explicit extra paths.

Project trust is honored for definitions/config/resources. `.pi/agents` alone does not trigger Pi's built-in trust prompt; use `/trust` or an explicit trust choice. Unknown/untrusted project definitions are skipped rather than loaded silently.

## Agent tools

All tools reject extra argument fields.

```text
create_agent(name, task, agent_template?: string | null)
send_message(agent_name, message)
wait_message(timeout?: number)   # seconds: default 120, >0 through 600
list_agents(all?: boolean)      # default false: direct children only
```

Instance names are workspace-unique and immutable. `main` is reserved. The sender and parent identities are supplied by the extension, not model arguments. Self-messaging is rejected. `list_agents(all: true)` includes main, parents, templates, status, effective model/thinking and errors; default listing includes idle direct children.

Creation acknowledges startup without waiting for the entire task. Messages enter as attributed steering context at Pi's next supported boundary. Sending to an idle worker restarts its **existing** session. At capacity, delivery remains queued until a slot becomes available. Worker final text automatically becomes a message to its parent once per run; failure/interruption produces a distinct status notice. Idle workers remain addressable.

`wait_message` consumes unread message acknowledgments; full text is injected once as context. Timeouts return normally; cancellation and all-waiting/idle deadlock throw errors. The newest waiter is released when nobody else can make progress. Waiting does not block a sibling parallel send/create call.

## Persistence and lifecycle

Each worker uses a separate Pi JSONL file under the main configured session directory's `subagents/<workspace-id>/`. Workspace identity, membership, normalized template snapshots, run state, and delivery IDs are custom non-context entries. Communications are custom context messages with sender attribution.

Restart/reload reconstructs workers as idle, with no automatic token spending on interrupted tasks. Explicit messages resume them and reconcile pending deliveries. Missing/corrupt/mismatched worker files produce errors instead of silently starting new histories. Crash recovery is at-least-once: a crash between message persistence and acknowledgment can cause redelivery; IDs reconcile messages already persisted in context.

Main's template is fixed when its first actual user message is emitted. A durable non-context custom entry, `subagents.main-template-lock.v1`, records `{version: 1, template: "<selected name>"}`. The lock is session-wide, not branch-relative: reload/resume, compaction, and tree navigation scan **all** entries for this marker and old user history. Backtracking before the first prompt cannot unlock the session or restore an earlier template selection; the locked template wins over branch-local choices. Existing sessions with user history but no marker are migrated by locking their current chosen template at startup. A pending `/agent` picker rechecks the lock, current workspace, and idle state before applying its result.

A genuinely empty `/new` session unlocks template selection. Forks carrying user history or a lock marker inherit the lock, including a marker-only fork made before the user message was persisted. `/subagents` remains a read-only viewer and is unaffected by template locking.

Main session forks get new workspace identities and do not reuse original workers. Tree navigation uses branch-relative membership and stops old runs before reconstruction. Ephemeral roots use in-memory workers; tree navigation retains their histories within the process. No ephemeral history survives process exit.

Workers inherit cwd/trust and normal configured extensions except this root extension and known main-only context/UI/usage extensions. Question, plan, and goal extensions now load normally and use the shared interactive-only helpers: their tools are hidden, tool snippets/guidelines are omitted, and workflow guidance/continuations are suppressed outside the main TUI. Interactive tools cannot be re-enabled by template extras or called through nested tools. These helpers also protect a worker file opened separately in a TUI. See [shared/README.md](../shared/README.md) for marking other extension tools and prompt sections; Pi itself has no native interactive-only metadata field.

Session shutdown explicitly runs worker extension cleanup, including background bash processes, before disposing sessions.

Independent Pi processes must not simultaneously write the same workspace/worker files. There is no cross-process coordinator or workspace locking.

## Verification

```sh
npm --prefix .pi/extensions/subagents test
npm --prefix .pi/extensions/subagents run check
node --test .pi/extensions/*/test.cjs .pi/extensions/*/ui.test.cjs \
  .pi/extensions/subagents/runtime.test.cjs .pi/extensions/subagents/root.test.cjs \
  .pi/extensions/subagents/selection.test.cjs .pi/extensions/subagents/main-template-lock.test.cjs \
  tests/pi-compatibility.cjs
```

Tests use the installed Pi APIs and a deterministic fake provider; no paid model calls. `smoke.cjs` creates a disposable fake-provider directory for terminal validation. See `plans/walkthrough.md` for actual captured screens, results, and remaining unverified integrations.
