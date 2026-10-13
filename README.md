# Personal Pi extensions

Compatible with Pi 1.1.0 (`@earendil-works/pi-coding-agent`). Develop extensions in `pi/extensions/`; this checkout's `pi/` resources are linked to the user configuration. Run `/reload` after changing extensions.

- [`context`](pi/extensions/context/README.md): `/context` browses prompts, tool schemas, conversation context and estimated usage.
- [`subagents`](pi/extensions/subagents/README.md): YAML agent templates, persistent workers and same-group messaging. `/groups` selects a human viewer group; `/subagents` inspects its agents read-only. The bottom bar and agent cycling show only the selected group's members.
- [`workflow`](pi/extensions/workflow/README.md): directed JavaScript-file orchestration using the public codemode sandbox, local agent definitions, scoped sequence/parallel helpers and progress. Every launched agent is a headless root in its own isolated communication group.
- [`dynamic-workflows` skill](skills/dynamic-workflows/SKILL.md): authoring/running directed workflows, with a self-contained [read-only research example](skills/dynamic-workflows/examples/research.js).

All model-facing tools reject unknown argument names before execution. Groups/loadouts enforce **in-process tool policy, not OS isolation**; selected tools and workers can affect shared resources. Human viewer selection never grants models cross-group listing or messaging.

## Setup

From the repository root, install extension-local dependencies (Pi supplies host peer packages):

```sh
npm --prefix pi/extensions/subagents ci --ignore-scripts --legacy-peer-deps
npm --prefix pi/extensions/workflow ci --ignore-scripts --legacy-peer-deps
```

For the initial workflow dependency/lockfile setup, use `npm --prefix pi/extensions/workflow install --ignore-scripts --legacy-peer-deps` instead of `ci`. Do not install another physical copy of Pi's host SDK.

The checked-in `pi/settings.json` adds `+codemode` and `+workflow` to default tools. This does not direct invocation: **Do not use workflow unless directed.** Restrictive template loadouts and CLI overrides remain authoritative; leaf roots may select `workflow` independently of ordinary child-template permissions.

Optional skill installation with the existing skill manager (commands for the user; not automatically run):

```sh
manage-skills add /home/jack/projects/pi_extensions/skills/dynamic-workflows
manage-skills sync --agent pi
```

Adjust the checkout path if needed, then `/reload`. For a single session, use `pi --skill ./skills/dynamic-workflows` instead; agent templates can use `skills.extra_paths`. Installing/loading the skill does not execute its example or alter child permissions. No global skill-manager state needs to change for tests.

## Verification

```sh
npm --prefix pi/extensions/workflow test
npm --prefix pi/extensions/workflow run check
npm --prefix pi/extensions/subagents test
npm --prefix pi/extensions/subagents run check
node --test pi/extensions/*/test.cjs pi/extensions/*/*.test.cjs tests/*.cjs
git diff --check
```

Tests use the installed host APIs and deterministic fake providers, with no paid model calls. Pi loads TypeScript through jiti; there is no repository-wide build command. See extension READMEs and `plans/walkthrough.md` for actual verification results and remaining unverified integrations.
