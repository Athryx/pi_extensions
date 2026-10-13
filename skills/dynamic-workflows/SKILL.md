---
name: dynamic-workflows
description: Write and run directed JavaScript workflows with registered agents, scoped sequence/parallel composition, and progress labels.
---

# Dynamic workflows

**Do not use workflow unless directed** by the user or your configured instructions. Review unfamiliar workflow files before executing them: their tools and agents can have real effects.

## Run a workflow

Write a regular `.js` file, then call the `workflow` tool:

```json
{"path":"./workflows/research.js"}
```

Paths resolve from the session's cwd; absolute paths and leading `~` also work. Tools and agents use the session cwd, not the workflow file's directory. For a complete example, read `examples/research.js`, resolved against this skill's directory.

The file is an **async function body**: top-level `await` and `return` work. Do not use exports, imports, `require`, Node APIs, direct filesystem/network access, or timers. Use tools and models for external work.

An optional first line configures output size and a hard deadline:

```js
// @options: {"max_output_tokens": 2000, "timeout_ms": 120000}
```

Allow enough time for agents to queue and complete. Call the workflow tool directly; do not invoke it through `tools.workflow`.

## Define and launch agents

Register all roles your workflow needs, then launch them by name:

```js
await workflow.register_agents([
  {
    name: "reader",
    tools: { include_defaults: false, extra: ["read"] },
    skills: { include_defaults: false },
    prompt: "Read only the assigned files. Return concise findings with supporting paths. Do not change files.",
    subagents: { include_defaults: false },
  },
]);

const findings = await workflow.agent(
  "Read README.md. Return three supported facts; report if it is missing.",
  "reader",
);
return findings;
```

Useful definition fields:

| Field | Usage |
| --- | --- |
| `name` | Required role name; starts with a letter, at most 64 letters/digits/underscores/hyphens. |
| `prompt` | Instructions for the role. |
| `tools` | `{include_defaults, extra}`; extras are tool names. Defaults are enabled unless explicitly disabled. |
| `skills` | `{include_defaults, extra_paths}`; defaults are enabled unless disabled. Relative extra paths resolve from the workflow file's directory. |
| `model` | `{name, thinking}`; omitted values inherit from the caller. `name` accepts `parent`, `global`, or `provider/model-id`; `thinking` accepts `parent`, `global`, or `off|minimal|low|medium|high|xhigh|max`. `global` uses the main session's selection. |
| `subagents` | Disabled by default. To let a role create children, use `{include_defaults: false, extra: ["child-role"], default: "child-role"}` with registered role names. Prefer workflow composition for fan-out. |

Choose narrow tool and skill loadouts. Registration is atomic; unknown fields, duplicate names, invalid values and missing child-role references fail. Later batches can add roles, not replace definitions. Roles are available only within this invocation.

Each `workflow.agent(prompt, definitionName, optionalName)` launches a **new isolated agent** and resolves to its final text string, or `""` if it has no final text. Failures reject. The optional name is a prefix: generated names append a unique counter.

Give every agent a complete task, inputs, constraints and expected output. Agents do not inherit your conversation or already-read skill bodies. Pass data through prompts and returned values; workflow agents cannot message each other or their caller. Isolation does not separate their files or filesystem permissions.

## Compose stages and branches

```text
await workflow.sequence(stages, optionalLabel)   -> last result, or undefined
await workflow.parallel(branches, optionalLabel) -> results in input order, or []
await workflow.set_status(label)
```

- Sequence callbacks receive `(priorResult, scopedWorkflow)`. The first prior result is `undefined`.
- Parallel callbacks receive `(scopedWorkflow)` only. Result order matches callback order, not completion order.
- Use the callback's **scoped workflow object** for agents, nested compositions, tools and models. Do not close over the root `workflow`, `tools` or `models` for branch work.
- Await status updates. Use short **2–5 word labels** (maximum 80 characters), not logs, prompts, paths, secrets or answers.

After registering `reader`, for example:

```js
return await workflow.sequence([
  async (_prior, w) => {
    await w.set_status("Read project files");
    return await w.parallel([
      async branch => {
        await branch.set_status("Read project overview");
        return await branch.agent("Read README.md; return three supported facts.", "reader");
      },
      async branch => {
        await branch.set_status("Read project conventions");
        return await branch.agent("Read AGENTS.md; return relevant conventions.", "reader", "conventions");
      },
    ], "Gather evidence");
  },
  async (findings, w) => {
    await w.set_status("Prepare final summary");
    return findings.join("\n\n");
  },
], "Project overview");
```

## Tools, models and output

Use `workflow.tools.<tool>(args)` and `workflow.models.<method>(...args)`, or the supplied scoped facade's `tools` and `models` inside callbacks.

Discover tools with `ALL_TOOLS`, `searchTools`, `describeTool` and `describeNamespace`; check their arguments and result declarations. Check structured error results rather than assuming every tool failure throws. `models` provides catalog access and non-chat classifier/image calls; inspect declarations and check `stopReason`/`errorMessage`. Calls can incur usage and cost.

Use `return`, `text` or `console` for concise output, and `image` for images—never print base64. `exit()` ends the script. `store` and `load` hold small JSON values across successful runs; failed runs do not commit writes. Save large artifacts using tools instead.

**Await every operation**, including agents, tools, compositions and status changes. Fan-out beyond available worker capacity (`max_running`) queues. Avoid nested workflows that occupy every worker slot while waiting for more workers.

`max_depth` limits ordinary child-agent nesting inside each group, starting at 0 for its root. `max_group_depth` separately limits nested workflow agent groups: the workspace's root group is 0, a first workflow agent group is 1, and its workflow agent group is 2. Workflow containers and sequence/parallel wrappers do not add depth. Depth-limit violations reject rather than queue.

## Handle failures and side effects

A failed sequence skips later stages. Parallel rejects on the first branch failure, cancels sibling work and waits for cleanup. Cancelled scoped facades reject further operations. A caught failure can use the still-live parent facade for fallback:

```js
try {
  return await workflow.parallel([
    async w => await w.agent("Read README.md and summarize it.", "reader"),
    async w => await w.agent("Read AGENTS.md and summarize it.", "reader"),
  ], "Read documentation");
} catch (error) {
  await workflow.set_status("Prepare fallback summary");
  return "Research failed: " + String(error);
}
```

Catch errors inside a branch only when its work is genuinely optional. Do not turn required failures into successful findings.

Cancellation cannot undo completed side effects. Do not run concurrent branches that modify the same files: use separate paths or serialize writes. Outstanding owned work is cleaned up when its scope or workflow ends; do not rely on unawaited work continuing afterward. Implement retries explicitly when appropriate.

## Usage Guidance

- Defining agents:
  - Prefer giving default tools to an agent which may read and write files or run commands
  - Prefer giving only codemode, read, ls, grep, glob tools to a read only agent
  - DO NOT give any agents in the workflow the workflow tool itself
  - Prefer explicitly specifying skills to use relevent to the agent, and turning of default including all skills
