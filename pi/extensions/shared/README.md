# Shared extension policies and capabilities

## Streamed provider tools

[`provider-tools.ts`](provider-tools.ts) connects provider-side tool activity to the custom UI without inventing local tool calls. Create a reporter once in a provider adapter's factory, before registering its request handlers:

```ts
import { createProviderToolReporter, type ProviderToolStream } from "../shared/provider-tools";

export default function (pi: ExtensionAPI) {
  const reporter = createProviderToolReporter(pi, "my-provider");
  let tools: ProviderToolStream | undefined;
  pi.on("before_provider_request", () => { tools = reporter.begin(); });
  pi.on("provider_stream_event", event => {
    // Parse your provider's event here, without modifying event.data.
    // Use the same id for subsequent argument/status updates to this call.
    tools?.update({
      id: "provider-call-id",
      label: "rendered diagram",
      summary: "system overview",
      status: "running", // running | completed | error | cancelled
    });
  });
}
```

The sample update belongs inside the adapter's matching-tool-event branch, not every stream event. The UI is provider-independent: adapters supply their display labels and concise arguments. `codex-web-search` uses this API for native search, page-open and find-in-page events.

One coordinator is discovered through the session's own `pi.events`; multiple adapters share it and their call IDs are namespaced. `begin()` returns a request-scoped stream. `update()` upserts a row in discovery order; identical snapshots do not request a redraw. It returns `false` for stale/closed streams, malformed updates, or more than 256 rows per response. Labels are capped at 120 characters and argument summaries at 8,192. No raw provider envelopes, credentials, callbacks, or execution capabilities are retained.

Version-1 `providerToolCalls` metadata is attached to live assistant-message clones and persisted on the finalized assistant message. Pi's normal serializers ignore this display-only field; it is not a function declaration or a model-facing tool result. The compact UI renders the rows above their associated assistant response, even before any text delta, and restores the same placement after resume. Existing source summaries may remain as model context or native-mode UI, with `inlineProviderTools: true` marking web-search summaries that compact mode must not render a second time.

Running rows become completed, error, or cancelled when the message finishes. Session/model/tree changes invalidate request handles, and shutdown withdraws the service. New requests get fresh metadata; prior messages keep their completed snapshots. `PROVIDER_TOOLS_CHANGED` is a session-local display notification used to redraw main and viewed-worker transcripts. It exposes no model-facing cross-agent discovery or messaging.

## Interactive-only policy

Pi 1.1.0 has no native `interactiveOnly` tool/prompt field. These helpers implement an extension-owned policy without modifying Pi.

An interactive agent is a **main TUI session**, not a print/JSON/RPC session or a persisted worker opened in the TUI. UI availability alone does not make a worker interactive.

## Tools and attached usage guidance

Prefer registering interactive tools in `session_start`:

```ts
import { registerInteractiveTool } from "../shared/interactive";

pi.on("session_start", (_event, ctx) => {
  registerInteractiveTool(pi, {
    name: "user_action",
    label: "User Action",
    description: "Interact with the user",
    promptSnippet: "Ask the user to choose an action",
    promptGuidelines: ["Only use when user input is needed."],
    parameters: Type.Object({}, { additionalProperties: false }),
    async execute(_id, _args, _signal, _update, ctx) {
      // Your interactive implementation.
      return { content: [], details: undefined };
    },
  }, ctx);
});
```

The helper marks the definition `interactiveOnly: true`. Outside the main TUI it registers the tool as hidden/inactive and removes `promptSnippet` and `promptGuidelines`. Its execution wrapper rejects non-interactive contexts, including nested/direct calls. Worker loadout resolution filters those tools even if defaults or template extras select them.

For definitions registered during extension loading, `interactiveTool(definition)` attaches the same marker and execution guard. The worker loader recognizes this marker and hides the definition. Use `registerInteractiveTool(..., ctx)` for lifecycle/dynamic registrations and for headless main-session suppression; raw marker metadata alone is not interpreted by Pi.

## Standalone usage snippets

```ts
import { interactiveSection, isInteractive } from "../shared/interactive";

pi.on("before_agent_start", (event, ctx) => {
  interactiveSection(event.systemPromptOptions.sections,
    "my_workflow", "Interactive workflow instructions", ctx);
});
```

`interactiveSection` adds the named section only in the main TUI and removes any stale value elsewhere, preserving unrelated sections. Tool-attached guidance is handled by the tool helper automatically.

Guard commands, input-driven custom messages, state restoration, UI work, and automatic continuation with `isInteractive(ctx)`. Filtering model-facing tools/prompts does not prevent an extension factory or arbitrary event handler from running. This is not a sandbox or a way to erase guidance already present in an existing conversation.

Question, plan, and goal mode use this shared policy. General-purpose background-safe tools need no marker.

## Workflow-agent capability

[`workflow-agents.ts`](workflow-agents.ts) provides version-1 in-process discovery through the **requesting session's** `pi.events`:

```ts
import { requestWorkflowAgentsAPI } from "../shared/workflow-agents";

const api = requestWorkflowAgentsAPI(pi);
if (!api) throw new Error("Workflow requires an active subagents workspace");
const run = api.openRun({ sourcePath, signal });
try {
  await run.registerAgents(definitions);
  const completed = await run.agent(prompt, template, prefix, signal);
  // completed.text is the privately returned final worker text.
} finally {
  await run.close();
}
```

The subagents main integration and worker inline factory provide the same coordinator-backed service, bound to the **actual caller and its group**. Scripts never supply an owner, parent, workspace/group ID or permission-bypass flag. Require the active capability; do not spawn unmanaged sessions as a fallback. Discover at execution time and do not retain capabilities across reload, tree navigation, new/fork/session replacement or shutdown; those lifecycle changes invalidate the bound workspace.

Keep four concepts separate:

- **Template authority:** immutable workflow-local definitions can launch through their invocation's capability without normal child-template permission. Existing YAML templates still require the caller's permission. Local registration does not change global templates, `/agent` choices or ordinary `create_agent` permissions. Relative skill resources resolve from the workflow file.
- **Communication membership:** each invocation creates a workflow container and every `agent` call creates a separate child member group. Its root is a headless worker with no messaging parent. Ordinary children remain in the creator's group. List/send/wait operations are group-local, including `list_agents(all: true)`; ancestor/sibling group relationships grant no access.
- **Human UI ancestry:** `/groups` navigates the group tree; `/subagents` and the bottom bar show the selected group's direct members. Empty containers show an overview, not flattened descendants. These are read-only views and never alter the model's identity/loadout.
- **Private ownership:** host completion handles return final text without cross-group messages. Ownership tracks cancellation and usage across groups. Agent depth is local to each group (`max_depth`); agent-group ancestry has a separate `max_group_depth` limit that ignores workflow containers. Worker capacity (`max_running`) remains workspace-wide. Progress sequence/parallel scopes are not agent groups.

A group root without child-template permissions receives none of `create_agent`, `list_agents`, `send_message`, `wait_message`, including through defaults/extras or nested discovery. This is based on group-root identity, not the name `main` or interactive role. The separately selected `workflow` tool may still be used by a directed leaf root. Non-root leaf workers retain their same-group communications.

The capability and group/loadout restrictions are **in-process tool policy, not an OS sandbox**. Workers and selected tools can still touch shared files or other resources. The JS VM lacks direct Node/filesystem/network APIs, but that does not isolate worker effects or undo completed actions. Workflow progress subscriptions are trusted human-UI plumbing, not a model-facing cross-group discovery service. See [subagents](../subagents/README.md) and [workflow](../workflow/README.md).
