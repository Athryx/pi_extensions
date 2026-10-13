# Dynamic workflows

Model-facing tool: `workflow({path: "task.js"})`.

**Do not use workflow unless directed.** Direction can come from the user or configured agent instructions. There is no confirmation dialog. Read the dynamic-workflows skill before authoring or changing workflows.

## Setup

The extension requires the subagents workspace integration and Pi 1.1.0 public APIs.

```sh
npm --prefix pi/extensions/workflow ci --ignore-scripts --legacy-peer-deps
```

Reload Pi after installation. The public `@earendil-works/pi-codemode` sandbox dependency is pinned to 1.1.0; host SDK/AI/TUI/TypeBox are peers, not installed duplicate runtime dependencies.

Skill installation commands below are **optional user instructions**, not automatic extension actions:

```sh
manage-skills add /home/jack/projects/pi_extensions/skills/dynamic-workflows
manage-skills sync --agent pi
```

Alternatively use `pi --skill ./skills/dynamic-workflows` or template `skills.extra_paths`.

## Script API

Files are ordinary JavaScript **async function bodies**, not modules. Top-level await/return work. Files must be readable regular `.js` files, at most 1 MiB; symlinks are allowed. Relative paths resolve from the tool cwd; leading `~/` expands normally. Worker skill resource paths resolve relative to the workflow source directory, without changing tool cwd.

```js
// @options: {"max_output_tokens": 2000}
await workflow.register_agents([
  {
    name: "reader",
    tools: { include_defaults: false, extra: ["read"] },
    subagents: { include_defaults: false },
    prompt: "Inspect the assigned file and return concise findings with paths.",
  },
]);

return await workflow.sequence([
  async (_prior, w) => {
    await w.set_status("Inspect files");
    return await w.parallel([
      async branch => {
        await branch.set_status("Read architecture");
        return await branch.agent("Read README.md and summarize architecture.", "reader");
      },
      async branch => {
        await branch.set_status("Read conventions");
        return await branch.agent("Read AGENTS.md and summarize conventions.", "reader", "conventions");
      },
    ], "Research");
  },
  async (findings, w) => {
    await w.set_status("Collect findings");
    return findings.join("\n\n");
  },
], "Repository overview");
```

- `register_agents(definitions)`: await atomic registration of YAML-equivalent public agent objects. Definitions remain local and immutable; they do not modify installed templates or `/agent` choices. Existing YAML templates are only usable when the caller already permits them.
- `agent(prompt, template, name?)`: always launches a fresh uniquely named headless agent and returns its final text, or `""` when successful without text. Names are prefixes with generated numeric suffixes.
- `sequence([(prior, w) => ...], label?)`: the first prior result is `undefined`; passes each result directly to the next callback, preserving closures/identity. Empty sequences return `undefined`.
- `parallel([(w) => ...], label?)`: returns results in input order; empty parallel returns `[]`. First failure cancels sibling scoped work, awaits host cleanup and rejects with the original failure and composition context.
- `set_status(label)`: await short progress labels (1–80 characters; usually 2–5 words). Do not put prompts, answers or secrets in labels.
- `w.tools` / `w.models`: use scoped counterparts inside callbacks. Await every operation.

A caught parallel failure permits fallback through the still-live parent facade. Cancelled/finished facades cannot start further work. Cancellation does not roll back file/tool effects and cannot forcibly settle arbitrary pure-JS callbacks without terminating the whole VM. Remaining callbacks are observed, not awaited indefinitely after sibling failure.

Each invocation creates a workflow container beneath the caller's agent group. Every `agent()` creates its own isolated child agent group: siblings and caller cannot message/list each other. Return data through task inputs and helper results. Ordinary children remain in their creator's group. Group roots are headless, not interactive; leaf roots have no create/list/send/wait tools. Groups are communication boundaries, **not OS/filesystem/credential isolation**. `max_running` remains workspace-wide. `max_depth` limits agent nesting within each group (group roots are depth 0); `max_group_depth` limits nested agent groups (root group 0, first workflow agent group 1). Workflow containers and composition wrappers do not add depth. Both depth limits default to 4; exceeding either rejects the launch, while excess worker fan-out queues.

The human can inspect retained groups with `/groups`, then agents with `/subagents`. Inspection never changes model permissions or resumes a worker.

## Sandbox and codemode compatibility

Execution uses the public QuickJS package, never Node evaluation. Scripts have no Node, filesystem, network, timers, or module imports. Host operations are strictly validated and can only use the current caller-bound workspace, issued scopes and callable tools. Sandbox confinement does not constrain effects of authorized host tools or worker sessions.

Retains `tools`, `ALL_TOOLS`, `searchTools`, `describeTool`, `describeNamespace`, `models`, `text`, `image`, `console`, `exit`, `store`, `load`, and top-level return. Tools run exclusively through `ctx.executeTool`, retaining hooks/validation/loadout checks. `workflow` and `codemode` are excluded from nested callable tools. Structured tool/MCP results are preserved, including structured error values as in codemode; ordinary error results reject. Image reads return image blocks with notes.

Model catalog headers are redacted. Non-LLM classifier/image execution resolves only provider/id against the host registry; script URLs/headers never receive host credentials. At most four model calls run concurrently, including root/scoped calls. Model and agent usage is reported once; nested host-tool usage is already accounted for by Pi.

Store writes use branch-relative `codemode-store` entries and commit only on successful execution (including `exit()`), intentionally sharing codemode's session store.

Output follows codemode text/console/image ordering. Final return appends like `text`. Failures retain partial output and return `isError: true`; source stack frames map back to the workflow file, not bootstrap lines. Default output budget is 10,000 estimated tokens; truncation preserves start/end with a full-output temp-file path. Images are saved to private temp files with path labels.

Limits: 256 MiB VM heap; public sandbox 16 MiB output / 100,000 output items; 256 KiB per store value / 1 MiB store total; 10,000 progress nodes. There is no default time deadline; `// @options: {"timeout_ms": 60000}` adds a hard deadline. Completed/error/abort/timeout/exit execution cancels and awaits remaining owned host work. No automatic reload/crash restart or checkpointing is provided.

Discovery/declaration/output glue is local Pi 1.1.0 compatibility code, not the private built-in execute implementation. BM25 discovery ranks only caller-permitted tools. Public sandbox and installed built-in codemode compatibility tests cover output/store/results; real SDK integration covers normal and codemode-only loadouts.

## Progress and lifecycle

TUI progress above the editor aggregates active workflows from all workers, attributed to their owners. Sequences show the active and immediately preceding stage; parallel branches show fan-out and queued/running/terminal labels. Composition nodes are not agent groups. The compact widget is bounded to 12 rows; expanded tool details retain the bounded tree.

Progress is also delivered through normal tool updates/results in print/JSON/RPC, without terminal widgets or stdout writes. Widgets/renderers cache unchanged width/content/theme layouts and invalidate on revision/resize/theme changes. Terminal snapshots remain in tool results; live widgets/subscriptions are cleaned up at lifecycle invalidation.

## Verification

No paid model providers are used by these deterministic tests.

```sh
npm --prefix pi/extensions/workflow test
npm --prefix pi/extensions/workflow run check
node --test tests/dynamic-workflows.cjs
node tests/dynamic-workflows-smoke.cjs
```

The smoke command launches a disposable real TUI fixture with a fake provider; see the root walkthrough for captured artifacts and broader workspace/group tests.
