# Agorax v2.5.0 — Multi-Agent & Claude Code

Agorax 2.5.0 ships the multi-agent control plane and first-class Claude Code chat as a managed runtime alongside Hermes.

## Highlights

- **Mission Control + pipelines**
  - Mission Control surfaces and pipelines API
  - `agents.yaml` declares how each runtime launches
  - Task-pipeline dispatch splits Hermes vs managed (Claude Code) paths

- **Group chat room workspaces**
  - Dual-mode room cwd: sticky ad-hoc path or mission-derived worktree/repo path
  - Turns resolve cwd once and pass it into managed runs / Hermes prompts

- **Claude Code in the agent workspace**
  - Non-interactive `-p` runs with MCP, model/effort, stream-json token/tool events
  - Skip-permissions for headless writes (no permission dialog bridge yet)
  - Session list in localStorage; switching back restores the last chat
  - Tool progress in Thinking chrome; reply bubble stays clean text
  - Composer clears on send; user-facing replies default to 简体中文

- **Editor embeds**
  - Excalidraw and Mermaid in markdown

## Suggested short release description

Agorax 2.5.0 adds Multi-Agent Mission Control, room workspace dual-mode, and Claude Code as a managed chat runtime with streaming, session restore, and headless permission bypass.

## Upgrade notes

- Claude Code managed runs use `--dangerously-skip-permissions` (no interactive approval UI in Hermes yet). Use only in trusted workspaces.
- Room workspace paths: mission-bound rooms lock path; ad-hoc rooms remain editable.
- Existing Claude Code chats live in browser `localStorage` under `hermes:external-chat:*`.
