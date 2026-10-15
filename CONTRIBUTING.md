# Contributing to Agorax

Thanks for your interest in contributing! Here's how to get started.

## Requirements

- Node.js 22+
- pnpm
- Python ≥ 3.10 (recommended 3.11+) for the LangGraph orchestrator
- A running [Hermes Agent](https://github.com/NousResearch/hermes-agent) gateway

## Quick Start

1. Fork the repo and clone your fork
2. Install dependencies:
   ```bash
   pnpm install
   ```
3. Copy and edit environment variables:
   ```bash
   cp .env.example .env
   # Edit .env — see Environment Variables below
   ```
4. Start the Hermes Agent gateway:
   ```bash
   hermes gateway run
   ```
   The gateway runs on `:8642` by default. The gateway HTTP API server is opt-in; add `API_SERVER_ENABLED=true` to `~/.hermes/.env` and restart it.
5. (Optional) Start the dashboard:
   ```bash
   hermes dashboard --port 9119 --host 127.0.0.1 --no-open
   ```
6. Set up the orchestrator Python venv (one-time):
   ```bash
   cd hermes_langgraph_orchestrator
   python3.11 -m venv .venv && .venv/bin/pip install -r requirements.txt
   cd ..
   ```
7. Configure tmux (required for Swarm/TUI mode):
   Add to `~/.tmux.conf`:
   ```
   set -g exit-empty off
   set -g exit-unattached off
   ```
8. Run the dev stack:
   ```bash
   # Full stack: gateway + managed-agent daemon (:8788) + Vite UI (:6734)
   pnpm dev

   # Or UI only (assumes gateway and daemon are already running)
   pnpm dev:ui
   ```
9. Make your changes on a feature branch
10. Open a PR against `main`

## Development Commands

```bash
# Install dependencies
pnpm install

# Full dev stack (UI default: localhost:6734)
pnpm dev

# UI only
pnpm dev:ui

# Managed-agent daemon only
pnpm dev:managed-agent

# Type check
npx tsc --noEmit

# Lint
pnpm lint

# Build for production
pnpm build

# Production start (builds UI + starts full stack)
pnpm build && pnpm start

# Run tests
pnpm test
```

## Environment Variables

See `.env.example` for all options. Key ones:

- `HERMES_API_URL` — Hermes Agent gateway backend (default: `http://127.0.0.1:8642`)
- `HERMES_API_TOKEN` — API token for the Hermes gateway (required when `API_SERVER_KEY` is set)
- `HERMES_DASHBOARD_URL` — Hermes dashboard URL (default: `http://127.0.0.1:9119`)
- `AGORAX_MANAGED_AGENT_URL` — Managed-agent daemon URL (default: `http://127.0.0.1:8788`)
- `AGORAX_WORKSPACE_ID` — Workspace ID for the managed-agent daemon (default: `default`)
- `HERMES_PASSWORD` — Optional password protection for the web UI (legacy `CLAUDE_PASSWORD` still honored)
- `HOST` — Bind address (default: `127.0.0.1`)

## Guidelines

- **One PR per feature/fix** — keep them focused
- **Test your changes** — make sure the app builds (`npx tsc --noEmit`) and runs
- **Describe what you changed** — clear PR title + description
- **No secrets** — never commit API keys, tokens, or passwords
- **Follow existing patterns** — match the code style you see
- **Keep docs in sync** — if you change `agents.yaml`, skills, tools, or workflow behavior, update `AGENTS.md` and relevant docs under `docs/`
