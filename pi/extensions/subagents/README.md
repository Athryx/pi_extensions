# Subagents

A named multi-agent workspace for Pi 1.1.0. The CLI remains the interactive `main` agent. Background agents have independent conversations/session files, restricted loadouts and **same-group** asynchronous communications. Main and ordinary descendants share the root group; each workflow-launched worker is a headless root in its own separate group.

## Setup

From the repository root:

```sh
npm --prefix pi/extensions/subagents ci --ignore-scripts --legacy-peer-deps
```

Pi supplies the peer packages; `--legacy-peer-deps` prevents npm from installing duplicate host copies locally. Reload Pi after installation. The only runtime dependency is `yaml`; TypeScript and Node typings are development dependencies.

Commands:

- `/agent [template]`: select the main conversation's template by name, or open Pi's native picker. Main must be idle and the session must not yet contain an actual user message. You can freely change templates before the first prompt; `/agent` commands, system messages, extension state, and custom context messages do not count. After the first user message, the template is locked: UI modes warn without opening a picker; modes without UI report an error. Use `/new` for an empty conversation where you can choose again. The command preserves the instance name, role, and existing children.
- `/groups [id|root]`: choose a group from the root-first hierarchical picker, select a stable group ID directly, or return to root. Labels are display text, not unique IDs. The picker includes empty workflow containers and queued/failed agent groups. Empty groups show a read-only overview and a “No agents” bar, never flattened child-group agents. Picker cancellation is a no-op.
- `/subagents [name]`: select an agent in the **current viewer group**, including idle workers, or view a named local agent directly. Out-of-group names require selecting their group with `/groups` first. `/subagents main` explicitly restores root/main for compatibility. Worker views are **read-only**, stay live when workers become idle/resume, and use the UI's normal transcript rendering/scrolling.

Viewer selection never changes the actual main session, model identity, tool permissions or task ownership. Selecting a member group restores its remembered valid agent, otherwise its root. Reload/new/fork/tree navigation/shutdown reset selection to root. Print/JSON/RPC commands report human-oriented group/member listings through their normal output channels, without terminal widgets or model-callable group-discovery tools.

In TUI mode an always-visible, wrapping row below the prompt shows the current group label and **only its direct member agents** as `● name (template)`. The dot is green for starting/running/waiting and grey for idle/error/interrupted agents; the actually viewed agent is highlighted. **Alt+]** / **Alt+[** cycle only current-group members, including idle workers; empty groups are a no-op. **Escape** restores root/main. These shortcuts require the UI extension's viewed-session API; `/subagents` keeps its native picker and overlay fallback.

Without compatible viewed-session support, group selection still applies and a read-only overlay/overview is used. Overlay tabs, parent details and idle counts remain group-local. Keys: Tab/Shift+Tab or left/right cycle agents; up/down, PageUp/PageDown and Home/End scroll; End follows streaming output; `i` includes idle/error/interrupted agents; `o` expands tool output; Escape or `q` returns to root/main. Mouse wheel scrolls the selected transcript. Selected workers remain visible when idle. Images from tool results honor Pi settings; user image attachments currently show their accompanying text only.

## YAML definitions

Put direct `.yaml`/`.yml` files in `<agent-dir>/agents/` (normally `~/.pi/agent/agents/`) or trusted `<cwd>/.pi/agents/`:

```yaml
name: reviewer
description: Reviews changes for correctness and regressions.
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

`description` is an optional string shown alongside the name in the `/agent` picker and completions. Agents permitted to spawn children receive a list of allowed child-template names and descriptions in their workspace instructions (including non-selectable templates). Omitted or blank descriptions show only the name. Descriptions are metadata, separate from the template’s `prompt` instructions.

`selectable` defaults to true. False hides a template from the `/agent` picker and completions only; explicit `/agent name`, child permissions, and `/subagents` group-local views are unaffected.

### Models

`model.name`: `parent`, `global`, or exact `provider/model-id` (model IDs may contain slashes). `model.thinking`: `parent`, `global`, or Pi's `off|minimal|low|medium|high|xhigh|max` levels. Omitted, null, or empty values inherit independently.

`global` means the user's main-session model/thinking selection, not the saved startup default. Applying an explicit `/agent` template does not overwrite the global choice. Main's `parent` falls back to global. Workers resolve at creation and again on idle resume; running workers do not follow mid-turn changes. Pi clamps unsupported thinking levels.

### Tools, skills and child permissions

`tools.include_defaults: true` uses Pi's resolved `defaultTools`: global `<agent-dir>/settings.json` merged with trusted `<cwd>/.pi/settings.json`, including Pi's `+tool`/`-tool` modifier behavior. When unset, Pi's standard read/bash/edit/write selection is used; an explicit empty array selects none. Workers do not inherit the parent's active tools or CLI overrides. Defaults are resolved when a worker runtime is created (including reconstruction after reload), not continuously during a run.

`tools.extra` contains ordered name modifiers: `name` or `+name` adds a tool, and `-name` removes it from the selected defaults. Modifiers apply in list order; removing an absent name is a no-op. For example, `extra: [-write, -edit, +codemode]` keeps other default tools and adds codemode. Explicit removals also apply to automatically added workspace/interactive tools and enhanced-bash companions; additions never override permission restrictions. A **group root** with no allowed child templates receives none of `create_agent`, `send_message`, `wait_message`, `list_agents`, even if named in defaults/extras or discovered/called through nested tools. This applies to main and headless workflow roots, not just agents named `main`. Non-root leaf workers retain same-group send/wait/list communications. With enhanced bash loaded, interact_bash/close_bash are retained only when default bash is selected. `include_defaults: false` keeps explicit extras plus eligible group communications. Interactive-only tools are filtered even when named in defaults/extras.

`workflow` is selected independently of these four workspace tools and ordinary child-template permissions. A leaf root may use a directed workflow if its loadout includes it. This checkout's `pi/settings.json` adds `+codemode` and `+workflow`; restrictive templates and CLI overrides remain authoritative. **Do not use workflow unless directed.** Availability is not direction to invoke it.

`create_agent` is unreachable unless the template allows child templates. Explicit creation must use an allowed template; omitting the template requires a configured default, never the first allowlist element. Empty `subagents` means a leaf agent. `subagents.include_defaults` defaults to false to preserve leaf behavior; true allows all valid discovered templates (user/project agents folders and configured extra paths), including non-selectable templates. `subagents.extra` contains ordered template-name modifiers, not paths: `name` or `+name` adds a child template, and `-name` subtracts it from the defaults. For example, `include_defaults: true` with `extra: [-main, -reviewer]` allows all other discovered templates. Removing an absent template is a no-op. Only the final explicit additions must resolve to existing templates. `default` must name a child remaining in the resolved list. `subagents.allowed` is no longer accepted; replace it with `extra` (and `include_defaults: false` for an explicit list).

Selected tool names must exist; removed names need not. Explicit `mcp__...` names get a bounded 10-second startup window for asynchronous registration; unavailable names still fail preflight. Initial unselected extension registrations are hidden; immutable SDK selection and a tool-call guard enforce restrictions on direct/nested calls, including late registrations. This is an **in-process tool policy, not OS isolation**. Configured extensions still execute code with Pi's privileges; group boundaries do not isolate filesystem, credentials, processes or networks.

`skills.include_defaults` defaults to true and includes normal Pi skill discovery. False makes worker catalogs extra-path-only. `skills.extra_paths` is a plain additive list of paths, with no `+`/`-` modifier syntax. Relative skill paths resolve from the YAML file. This does not copy the parent's transcript or already-read skill bodies. On main, skill filtering changes the model's advertised catalog; it cannot erase earlier context, remove all `/skill:` commands, or prevent reads through allowed tools.

This repository's `pi/agents/main.yaml` and `pi/agents/subagent.yaml` are ordinary templates: main allows/defaults to subagent; subagent is a leaf. They must be available through the normal agents directories (including this repository's symlinked configuration) or configured extra paths. The extension has no bundled definitions or special template-name/source-path behavior. Every main template uses the normal settings-based tool loadout while retaining tools for enabled interactive workflows such as plan/goal/question mode.

## Configuration and precedence

Optional `<agent-dir>/subagents.json` and trusted `<cwd>/.pi/subagents.json`:

```json
{
  "agent_paths": ["./extra-agents"],
  "default_agent": "main",
  "max_running": 8,
  "max_depth": 4,
  "max_group_depth": 4,
  "worker_exclude_extensions": []
}
```

Paths resolve from their owning configuration directory; absolute paths and `~` work. `worker_exclude_extensions` uses exact extension paths. Project scalar limits and `default_agent` override user values.

- `max_running` (default 8; 1–128): total starting/running/waiting workers across the workspace. Main and idle workers do not consume slots.
- `max_depth` (default 4; 1–128): ordinary agent nesting **within each group**. Main and each headless group root are depth 0; their ordinary children are depth 1. A new agent group resets this depth.
- `max_group_depth` (default 4; 0–128): nested **agent groups**, with the root group at depth 0. Workflow containers do not increment it. A first workflow agent is at group depth 1; its workflow agent is at group depth 2. Zero prevents creating workflow agent groups, but permits tool-only workflows.

Both depth limits apply independently; exceeding either fails immediately rather than queuing. Sequence/parallel wrappers add neither depth.

`default_agent` is an optional template name using the same strict name syntax as YAML definitions; null, empty names, and invalid names are rejected. It selects the interactive template for fresh sessions, including `/new`, and may name a non-selectable template. If omitted, the first selectable discovered template is selected, not a hardcoded `main` template. An unavailable configured default or absence of selectable templates (when no default is set) fails startup. Saved session identity/template selections and durable locks take precedence over this fresh-session default. The selected template's model/thinking settings apply at startup. This repository's `pi/subagents.json` sets `default_agent` to `main`.

Precedence, lowest to highest:

1. User agents directory.
2. User extra paths in declaration order.
3. Trusted current-project `.pi/agents`.
4. Trusted project extra paths.

Later locations override by template name. Duplicates within one location and malformed named overrides are quarantined, not silently replaced with older permissive definitions. Definitions naming missing child templates are also quarantined. Discovery is non-recursive and does not search ancestor projects. Run `/reload` to refresh definitions; ordinary global-template workers use the refreshed template on their next resume. Workflow-created workers instead use validated saved local-registry provenance, never a same-named changed global YAML.

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

Instance names are workspace-unique and immutable. `main` is reserved. Sender/parent/group identities come from the extension, not model arguments. Self-messaging is rejected. `list_agents(all: true)` includes only the caller's **own group**, including its root, idle members, templates, status, effective model/thinking and errors; default listing includes direct same-group children. It intentionally no longer means the whole workspace when multiple groups exist.

Ordinary creation acknowledges startup without waiting for the task and keeps the child in its creator's group. Messages enter as attributed steering context at Pi's next supported boundary. An authorized same-group send to an idle worker resumes its **existing** session; at capacity, delivery queues. Unknown and out-of-group targets produce the same unavailable-target error, even when a model knows the exact name. Ancestor/descendant groups grant no messaging rights, including to main.

Ordinary worker final text automatically becomes a message to its same-group parent once per run; failure/interruption produces a distinct status notice. A workflow root has **no messaging parent**, including on later resume. Its owned initial response returns privately to `workflow.agent`, not as a message to the workflow caller. Retained idle roots can be viewed, but main cannot resume them across groups; only an authorized same-group sender or explicit trusted-host/operator action can do so. The viewer is not an operator-resume interface.

`wait_message` consumes unread same-group acknowledgments; full text is injected once as context. Timeouts return normally; cancellation and local all-waiting/idle deadlock throw errors. Unrelated running groups cannot keep a local wait alive; legitimate host workflow dependencies are tracked separately. Waiting does not block a same-group sibling parallel send/create call.

## Dynamic workflows and agent groups

The [`workflow` extension](../workflow/README.md) executes directed JS files in the public codemode sandbox. Read [`skills/dynamic-workflows/SKILL.md`](../../../skills/dynamic-workflows/SKILL.md) before authoring/changing workflows. Register JS objects with the same public fields/defaults/validation as YAML; registration is awaited, atomic, immutable and invocation-local. Local definitions can launch without the caller's ordinary child-template permissions; existing YAML still requires permission. Local shadowing never modifies the global catalog, `/agent` or normal `create_agent` rights. Relative local skill paths resolve from the workflow JS file.

```text
Root group: main + ordinary descendants
└─ Workflow container (no agents)
   ├─ Agent group: researcher-1 (headless root + permitted ordinary children)
   │  └─ Nested workflow container
   │     └─ Agent group: analyst-1 (another isolated headless root)
   └─ Agent group: researcher-2 (isolated from researcher-1 and main)
```

Every `workflow.agent(prompt, template, prefix?)` creates its own group and fresh worker, even when templates repeat. Its root has role `worker`, no messaging parent and no interactive permissions. Model inheritance comes from the launching caller through private ownership, not a messaging parent. Optional names are prefixes; generated names use a numeric suffix and are not reusable handles. Groups share neither messages nor conversation context; communicate stage data through explicit task inputs and returned strings. No shared-group argument exists in v1. Sequence/parallel nodes describe progress only, not communication groups.

Worker capacity remains workspace-wide. Workflow fan-out queues without increasing `max_running`; ordinary `create_agent` retains immediate capacity errors. Waiting workers reserve slots. `max_depth` limits ordinary agent nesting separately within each group, while `max_group_depth` limits nesting of agent groups across workflows. A fresh group resets local agent depth, not group depth. Empty workflow containers consume neither worker capacity nor either depth. Nested workflows whose waiting owners exhaust capacity fail with an actionable deadlock diagnostic. Parallel failure cancels scoped siblings/owned descendants, including across owned group boundaries, not unrelated agents. Cancellation cannot undo completed side effects; never have concurrent branches write the same files.

The main TUI can show active workflow progress, including worker-owned workflows, while the group bar remains confined to the selected group's direct members. Human `/groups` access is not model cross-group access. Groups/loadouts are **in-process tool policy, not OS isolation**: selected tools can still access shared resources.

## Persistence and lifecycle

Each worker uses a separate Pi JSONL file under the main configured session directory's `subagents/<workspace-id>/`. Workspace identity, group descriptors/membership, private ownership, normalized template/local-registry snapshots, run state and delivery IDs are versioned custom non-context entries. Communications are attributed custom context messages and must stay within a group, including when persisted/pending deliveries replay.

Restart/reload reconstructs workers as idle, with no automatic token spending or workflow restart. Authorized same-group messages resume workers and reconcile pending deliveries; workflow-root parentlessness is preserved. Local definitions needed for workflow workers/descendants persist as immutable provenance: deleting/changing the JS or global YAML does not substitute another template on resume. Missing/corrupt/mismatched worker files, group metadata or provenance fail closed instead of silently starting unrestricted histories. Crash recovery is at-least-once: a crash between message persistence and acknowledgment can cause redelivery; IDs reconcile messages already persisted in context.

Genuine legacy sessions without group metadata migrate main and ordinary workers into one root group, preserving prior local communications. Newly group-tagged entries with missing/mismatched references, cycles or corrupt metadata are errors, never a fallback into root. Reconstruction uses the active branch before replaying messages or applying loadouts. Human group selection is ephemeral and resets to root on lifecycle replacement; saved worker/group histories remain available for inspection.

Main's template is fixed when its first actual user message is emitted. A durable non-context custom entry, `subagents.main-template-lock.v1`, records `{version: 1, template: "<selected name>"}`. The lock is session-wide, not branch-relative: reload/resume, compaction, and tree navigation scan **all** entries for this marker and old user history. Backtracking before the first prompt cannot unlock the session or restore an earlier template selection; the locked template wins over branch-local choices. Existing sessions with user history but no marker are migrated by locking their current chosen template at startup. A pending `/agent` picker rechecks the lock, current workspace, and idle state before applying its result.

A genuinely empty `/new` session unlocks template selection. Forks carrying user history or a lock marker inherit the lock, including a marker-only fork made before the user message was persisted. `/subagents` remains a read-only viewer and is unaffected by template locking.

Main session forks get new workspace identities and do not reuse original workers. Tree navigation uses branch-relative membership and stops old runs before reconstruction. Ephemeral roots use in-memory workers; tree navigation retains their histories within the process. No ephemeral history survives process exit.

Workers inherit cwd/trust and normal configured extensions except this root extension and known main-only context/UI/usage extensions. Question, plan, and goal extensions now load normally and use the shared interactive-only helpers: their tools are hidden, tool snippets/guidelines are omitted, and workflow guidance/continuations are suppressed outside the main TUI. Interactive tools cannot be re-enabled by template extras or called through nested tools. These helpers also protect a worker file opened separately in a TUI. See [shared/README.md](../shared/README.md) for marking other extension tools and prompt sections; Pi itself has no native interactive-only metadata field.

Session shutdown explicitly runs worker extension cleanup, including background bash processes, before disposing sessions.

Independent Pi processes must not simultaneously write the same workspace/worker files. There is no cross-process coordinator or workspace locking.

## Verification

```sh
npm --prefix pi/extensions/subagents test
npm --prefix pi/extensions/subagents run check
npm --prefix pi/extensions/workflow test
npm --prefix pi/extensions/workflow run check
node --test pi/extensions/*/test.cjs pi/extensions/*/*.test.cjs tests/*.cjs
git diff --check
```

Tests use the installed Pi APIs and a deterministic fake provider; no paid model calls. `smoke.cjs` creates a disposable fake-provider directory for terminal validation. See `plans/walkthrough.md` for actual captured screens, results, and remaining unverified integrations.
