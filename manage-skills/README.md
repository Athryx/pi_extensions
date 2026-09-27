# manage-skills

A fast and safe Rust command-line tool to manage and synchronize AI coding agent skills across harnesses (`codex`, `antigravity`, `pi`, `opencode`, etc.).

## Features

- **Single Source of Truth**: Centralizes skill paths and agent harness directories in `~/.config/manage-skills/config.toml`.
- **State-Tracked Synchronization**: Records managed symlinks in `~/.config/manage-skills/state.toml`. Only symlinks created by this tool are ever removed; hand-crafted symlinks and real folders in agent directories are never deleted or modified.
- **Recursive Skill Discovery**: Recursively finds skill directories containing `SKILL.md` while skipping hidden directories, `node_modules`, and build targets.
- **Live Status Inspection**: Inspects agent folders in real-time, detailing managed symlink statuses, pending syncs, broken links, and unmanaged items.

## Installation

```bash
cargo install --path /home/jack/projects/pi_extensions/manage-skills
```

## Quick Start

### 1. Initialize Configuration
```bash
manage-skills init
```
Automatically detects installed agent harnesses on your system (`codex`, `antigravity`, `pi`, `opencode`) and creates `~/.config/manage-skills/config.toml`.

### 2. Add Skills
Add an individual skill directory:
```bash
manage-skills add /path/to/my-skill
```

Or recursively find all skills in a folder tree:
```bash
manage-skills add -r /home/jack/projects/pi_extensions/skills
```

Optionally pass `--sync` / `-s` to immediately link skills after adding:
```bash
manage-skills add -r /home/jack/projects/pi_extensions/skills --sync
```

### 3. Synchronize Skills to Agents
```bash
manage-skills sync
```

Or preview changes without touching the filesystem:
```bash
manage-skills sync --dry-run
```

Or sync to a single agent:
```bash
manage-skills sync --agent codex
```

### 4. Inspect Live Status
```bash
manage-skills list
```

### 5. Remove a Skill
```bash
manage-skills remove python-style --sync
```

### 6. Manage Agent Harnesses
```bash
manage-skills agent list
manage-skills agent add myagent ~/.myagent/skills
manage-skills agent remove myagent
```

## Configuration Format (`~/.config/manage-skills/config.toml`)

```toml
# System skills managed by this tool
skills = [
    "/home/jack/projects/pi_extensions/skills/python-style",
    "/home/jack/projects/pi_extensions/skills/skill-issue",
]

# Agent harness name to skills folder mapping (supports ~ and $HOME)
[agents]
antigravity = "~/.gemini/config/skills"
codex = "~/.codex/skills"
opencode = "~/.config/opencode/skills"
pi = "~/.pi/agent/skills"
```

## State Tracking (`~/.config/manage-skills/state.toml`)

Automatically updated by `sync` to track:
- Last synchronization timestamp per agent.
- Exact map of managed symlinks and source paths.

When a skill is removed from `config.toml`, future syncs check `state.toml` and verify the symlink's destination before deleting it.
