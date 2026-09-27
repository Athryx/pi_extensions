---
name: skill-issue
description: Report problems encountered while following another skill's instructions. Use immediately when a skill directs Codex to use unavailable, failing, incompatible, or unclear tooling, when the tooling contains bugs or is lacking in features, or when the skill itself is ambiguous, incomplete, contradictory, or otherwise prevents reliable execution.
---

# Report a Skill Issue

Create a concise issue report before continuing with the affected task. Do not use this skill for ordinary task uncertainty that is unrelated to a skill's instructions.

1. Identify the affected skill from its `name` field; if unavailable, use its directory name.
2. Create `/home/jack/skill_issue_reports/<skill-name>/` if it does not exist.
3. Create one Markdown file for the issue. Use a short, lowercase, snake_case name that identifies it, such as `missing_adb.md` or `ambiguous_build_step.md`. Do not overwrite an existing report; add a distinguishing suffix when necessary.
4. Include exactly the useful facts known at the time, using this structure:

```markdown
# <Short issue title>

## Work in progress
<What the agent was trying to do.>

## Working folder
`<absolute path, or "unknown">`

## Issue encountered
<What the skill instructed, what happened or was ambiguous, and why it blocked or risks unreliable work.>

## Possible fixes
<Optional, concrete improvements. Omit this section when no plausible fix is known.>
```

5. State the report path in the task update, then continue with safe alternatives or explain the blocker.

Keep reports factual and concise. Never place secrets, credentials, or unnecessary command output in a report.
