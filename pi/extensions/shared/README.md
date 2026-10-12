# Shared interactive-only policy

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
