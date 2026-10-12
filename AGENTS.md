All pi extensions should be developed in pi/extensions. Existing ones are:
- `bash`: replaces default pi bash tool; allows background sessions and interaction
- `ask-question`: provides ask_question tool
- `goal-mode`: sets agent running on long term goal with no expected user interaction
- `plan-mode`: command to tall agent to make a plan
- `context`: command to show conversation context
- `codex-usage`: shows current usage if using a codex model
- `ui`: alternate convesation ui modes, and ability to show different sessions
- `subagents`: subagent support


New pi extension tools developed should default to throwing an error if extra fields are submitted, unless otherwise stated.

directories in pi are symlinked to paths in global ~/.pi/agents, so changing them and reloading works.
