![Agorax](./public/agorax.png)

# *The Agora for AI agents — one square, every agent.*

![Version](https://img.shields.io/badge/version-2.5.0-2557b7.svg)
![License](https://img.shields.io/badge/license-MIT-blue.svg)
![Node](https://img.shields.io/badge/node-%3E%3D22.0.0-brightgreen.svg)
![PRs Welcome](https://img.shields.io/badge/PRs-welcome-6366F1.svg)

> **Agorax** is the public square for AI agents: a unified workspace where Hermes Agent profiles and managed runtimes (Claude Code, Codex, Cursor, OpenCode, Kimi, and more) share one interface for chat, missions, memory, skills, and multi-agent Swarm pipelines.

---



## ✨ What's inside

- 💬 **Chat** — Real-time SSE streaming, tool call rendering, multi-session, markdown + syntax highlighting
- 🧠 **Memory** — Browse, search, and edit agent memory; markdown live editor
- 🧩 **Skills** — Browse skills with origin badges, filters, source paths, and marketplace
- 🔌 **MCP** — Catalog, marketplace, sources, and local config CRUD
- 📁 **Files + Terminal** — Full workspace file browser with Monaco; cross-platform PTY terminal
- 🎯 **Missions + Agents** — Mission Control and agent registry; launch goals through the orchestrator
- 👥 **Agent View** — Live agent panel in chat with avatar, queue, history, usage meter
- 🐝 **Swarm Mode** — Persistent tmux-backed Hermes workers + managed runtimes with role-based dispatch
- 💻 **Group chat rooms** — Ad-hoc workspace paths or mission-derived worktree/repo paths
- 🤖 **Managed agent chat** — Claude Code, Codex, Cursor, OpenCode, Kimi as first-class chat runtimes
- 🗄️ **Dashboard** — Aggregated overview: sessions, model mix, cost ledger, attention card, ops strip
- 🎨 **Themes** — Hermes, Nous, Bronze, Slate, Mono (light + dark)
- 🔒 **Security** — Auth middleware on every route, CSP, path-traversal guard, fail-closed remote bind
- 📱 **PWA + Tailscale** — Install as a native-feeling app; access from any device on your tailnet
- ⚙️ **Capability gates** — Features that need upstream endpoints show a clean placeholder instead of failing mid-action

---



## 📸 Screenshots

> Screenshots are being refreshed for v2.5.0. New captures for Chat, Missions, Agents, Dashboard, Memory, Terminal, Settings, and Swarm will be added back here once they are generated.

---



## 🚀 Quick Start

Two paths — pick the one that matches you:


| Path                                         | Best for                                         | Time   |
| -------------------------------------------- | ------------------------------------------------ | ------ |
| **🐳 [Docker Compose](#-docker-quickstart)** | Self-hosters, home labs, "give me a compose gig" | ~2 min |
| **🌐 One-line install**                      | Local dev on macOS/Linux                         | ~3 min |




### What runs locally


| Service                                                                   | Port                             | How it starts                                                                                                                  |
| ------------------------------------------------------------------------- | -------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| **Agorax UI** (Workspace)                                                 | `:6734`                          | `pnpm dev` / `pnpm start` / `pnpm dev:ui` / `pnpm start:ui`                                                                    |
| **Hermes Agent gateway**                                                  | `:8642` (+ per-profile `:8643`…) | Manual `hermes gateway run`, included in `pnpm start` / `pnpm dev`, or lazy-started by the Workspace gateway pool on localhost |
| **Managed Agent daemon** (Claude Code / Codex / Cursor / OpenCode / Kimi) | `:8788`                          | `pnpm dev:managed-agent`, or included in `pnpm start` / `pnpm dev`                                                             |
| **Hermes dashboard** (optional analytics)                                 | `:9119`                          | `hermes dashboard`                                                                                                             |


Prerequisite: `API_SERVER_ENABLED=true` in `~/.hermes/.env` so the gateway serves HTTP APIs.

### One-line install

```bash
curl -fsSL https://raw.githubusercontent.com/jingr1/agorax/main/install.sh | bash
```

This clones into `~/agorax`, sets up `.env`, installs dependencies, and ensures `hermes-agent` is present. If Hermes Agent is already installed, the workspace will detect it; if not, the installer sets it up for you. Then:

```bash
cd ~/agorax
pnpm dev    # gateway + managed-agent (:8788) + UI (:6734)
```

Open [http://localhost:6734](http://localhost:6734). That's it.

Split terminals if you prefer:

```bash
hermes gateway run                  # terminal 1 · :8642 (optional on localhost — pool can lazy-start)
cd ~/agorax && pnpm dev:managed-agent   # terminal 2 · :8788 (only if you use managed agents)
cd ~/agorax && pnpm dev:ui                 # terminal 3 · :6734
```

Production mode (gateway + Managed Agent daemon + UI on `:6734`):

```bash
pnpm install   # required after clone, pull, or switching a worktree/branch
pnpm build && pnpm start
```

`pnpm start` starts Hermes gateway (skips if already running), Managed Agent daemon on `:8788`, and the production UI. For UI-only (e.g. systemd/launchd workspace service), use `pnpm start:ui`. Dev equivalent of the full stack: `pnpm dev` (Vite UI).

`node_modules` is not shared across git worktrees — after updating `release/*` (or any separate checkout), run `pnpm install` there before `pnpm build`. If start fails with `Could not locate the bindings file` for `better-sqlite3`, compile it with the same Node major you use to run (`node -v`):

```bash
npm run install --prefix "$(node -p "require('path').dirname(require.resolve('better-sqlite3/package.json'))")"
```

---



#### Running on a remote host (Tailscale / VPN / LAN)

If the workspace and its browser live on different machines, point `HERMES_API_URL` at the **reachable** backend address, not `127.0.0.1`:

```bash
# On the server running the workspace + gateway:
echo 'HERMES_API_URL=http://100.x.y.z:8642' >> .env
# Optional: dashboard URL for analytics (not required for core functionality)
# echo 'HERMES_DASHBOARD_URL=http://100.x.y.z:9119' >> .env

# Also tell the gateway to listen on all interfaces so remote peers can reach it.
# In ~/.hermes/.env:
echo 'API_SERVER_HOST=0.0.0.0' >> ~/.hermes/.env
```

Then restart the gateway and workspace. Hit the workspace from the remote device and the connection probe will use the Tailscale IP instead of localhost.

**If you've already started the workspace**, you can update both URLs from `Settings → Connection` without restarting. The values are persisted to `~/.hermes/workspace-overrides.json` and take effect immediately (gateway capabilities are reprobed on save). Editing `.env` still works for pre-start config and for CI/containers.

---



### Manual install

Agorax works with any OpenAI-compatible backend. If your backend also exposes Hermes Agent gateway APIs, enhanced features like sessions, memory, skills, and jobs unlock automatically.

#### Prerequisites

- **Node.js 22+** — [nodejs.org](https://nodejs.org/)
- **An OpenAI-compatible backend** — local, self-hosted, or remote
- **Optional:** Python 3.11+ if you want to run a Hermes Agent gateway locally
- **Swarm / LangGraph missions:** Python **≥ 3.10** and a one-time `hermes_langgraph_orchestrator/.venv` (see [orchestrator README](./hermes_langgraph_orchestrator/README.md))



#### Step 1: Start your backend

Point Agorax at any backend that supports:

- `POST /v1/chat/completions`
- `GET /v1/models` recommended

Example Hermes Agent gateway setup (from scratch):

```bash
# Install hermes-agent
curl -fsSL https://raw.githubusercontent.com/NousResearch/hermes-agent/main/scripts/install.sh | bash

# Configure a provider + start the gateway
hermes setup
hermes gateway run
```

Our one-liner installer does both steps automatically. If you're using another OpenAI-compatible server, just note its base URL.

#### Step 2: Install & Run Agorax

```bash
# In a new terminal
git clone https://github.com/jingr1/agorax.git
cd agorax
pnpm install
cp .env.example .env
printf '\nHERMES_API_URL=http://127.0.0.1:8642\n' >> .env
pnpm dev             # gateway + managed-agent + UI → http://localhost:6734
# or just the UI (localhost gateway pool can lazy-start hermes):
# pnpm dev:ui
```

> **Verify:** Open `http://localhost:6734` and complete the onboarding flow. First connect the backend, then verify chat works. If your gateway exposes Hermes Agent APIs, advanced features appear automatically.



#### Run without an open terminal

After `pnpm build`, install Workspace as a user-level launchd/systemd service:

```bash
chmod +x scripts/install-dashboard-service.sh
scripts/install-dashboard-service.sh
```

See `[docs/dashboard-service.md](docs/dashboard-service.md)` for macOS launchd, Linux systemd, logs, overrides, and uninstall steps.

#### Environment Variables

```env
# OpenAI-compatible backend URL
HERMES_API_URL=http://127.0.0.1:8642

# Optional: provider keys the Hermes Agent gateway can read at runtime.
# You only need the key(s) for whichever provider(s) you actually use.
# OPENAI_API_KEY=sk-...                # GPT / o-series / OpenAI-compatible
# OPENROUTER_API_KEY=sk-or-v1-...      # OpenRouter (incl. free models)
# GOOGLE_API_KEY=AIza...               # Gemini
# (Ollama / LM Studio / local servers don't need a key)

# Optional: password-protect the web UI
# HERMES_PASSWORD=your_password
```

---



## Swarm Mode

Swarm turns Agorax into a live multi-agent control plane. A semantic roster of workers, declared in `[agents.yaml](agents.yaml)`, runs persistent tmux-backed Hermes Agents side-by-side with managed runtimes. The LangGraph orchestrator routes missions through a default pipeline while preserving human judgment at every gate.

**Default pipeline**

```text
orchestrator → researcher → architect → (developer | writer) → architect (review + harden) → learning
```


| Worker         | Role                                                           |
| -------------- | -------------------------------------------------------------- |
| `orchestrator` | Decompose missions, route work, hold the greenlight gate       |
| `researcher`   | Establish facts, trace sources, validate data                  |
| `architect`    | Design, choose the executor lane, review and harden            |
| `developer`    | Implement approved designs with tests and verified builds      |
| `writer`       | Produce slides, documents, narratives, and visual deliverables |
| `learning`     | Capture retrospectives and ingest durable knowledge            |


**Gate C — review retry limit.** When architect returns `changes_requested`, the same executor gets up to **3** retries before the mission escalates to a human gate.

**Gate H — harden gate.** After `approved`, architect runs the `harden-gate` skill to verify keys, paths, tests, and docs before release.

**Phase 2 Human Gate.** When `needs_human=true`, the `/swarm` panel shows the blocker, checkpoint, and routing analysis. Resume with **Continue** or **Abort**, or use `POST /api/swarm-langgraph/resume`.

Start here: [docs/swarm/QUICKSTART.md](./docs/swarm/QUICKSTART.md) · [docs/swarm/HANDOFF-PROTOCOL.md](./docs/swarm/HANDOFF-PROTOCOL.md)

**LangGraph orchestrator (required for Swarm missions from the UI):** needs a local venv once per machine — **Python ≥ 3.10** (3.11+ recommended):

```bash
cd hermes_langgraph_orchestrator
python3.11 -m venv .venv && .venv/bin/pip install -r requirements.txt
```

Details: [hermes_langgraph_orchestrator/README.md](./hermes_langgraph_orchestrator/README.md).

---



## 🤝 Pair an Agent with the Workspace

Agorax is the UI. **Hermes Agent** is the brain. Managed runtimes talk through the **Managed Agent daemon**.

```
┌───────────────┐   :8642 gateway    ┌────────────────┐
│   Agorax UI   │ ─────────────────▶ │  Hermes Agent  │
│   :6734       │ ◀───────────────── │  CLI / brain   │
└───────┬───────┘  (:9119 optional)  └────────────────┘
        │ :8788
        ▼
┌───────────────────────┐
│ Managed Agent daemon  │  Claude Code / Codex / Cursor / OpenCode / Kimi
└───────────────────────┘
```



### Unified agent registry

`[agents.yaml](agents.yaml)` is the single source of truth. It declares every worker's role, skills, tools, runtime, launch command, and dispatchability. The UI reads the registry from `GET /api/agents`; capabilities come from `GET /api/agents/:id/capabilities`.


| Track       | Runtime                                                                       | Profiles                                 | Capability source                                      |
| ----------- | ----------------------------------------------------------------------------- | ---------------------------------------- | ------------------------------------------------------ |
| **Hermes**  | `hermes`                                                                      | `~/.hermes` / `~/.hermes/profiles/<id>/` | Profile filesystem (config.yaml, skills, MCP bindings) |
| **Managed** | `claude-code` / `codex` / `cursor` / `opencode` / `kimi` / `deepseek-harness` | Collab bindings + runtime settings       | Platform adapter + per-run config                      |


`default` is a first-class agent too: its Hermes home is `~/.hermes` (not `profiles/default`), and it is non-dispatchable but fully visible in Agents / Skills / MCP binding.

### Recommended: one command

```bash
cd ~/agorax   # or your clone path
pnpm dev
```

Starts Hermes gateway (skips if already running), Managed Agent daemon on `:8788`, and the UI on `:6734`.

### Or split terminals

```bash
hermes gateway run     # terminal 1 · :8642 · chat, models, streaming, jobs, sessions, skills, config
hermes dashboard       # (optional) · :9119 · analytics only
pnpm dev:managed-agent # terminal 2 · :8788 · managed runtimes
pnpm dev:ui            # terminal 3 · :6734 · the UI
```

On localhost, if you only run `pnpm dev:ui`, the **gateway pool** can lazy-start one API gateway per active profile (`AGORAX_AUTO_START_AGENT=false` disables that). Set `HERMES_API_URL` to a remote host to keep single-gateway pairing. Swarm workers still use per-profile `HERMES_HOME` + tmux and do not go through this pool.

Managed Agent Chat needs `AGORAX_MANAGED_AGENT_URL=http://127.0.0.1:8788` and `AGORAX_WORKSPACE_ID=default` in `.env` (both are in `.env.example`). `dev:managed-agent` is idempotent: if `:8788` already answers `/health`, it skips instead of failing with `bind: address already in use`.

### Windows (PowerShell + WSL) one-command startup

If you use Agorax from Windows with the agent running in WSL, use the helper script in this repo:

```powershell
# from the repo root
.\scripts\start-agorax.ps1
```

To force a clean relaunch of the tmux session:

```powershell
.\scripts\start-agorax.ps1 -Restart
```

Optional parameters:

- `-Distro <name>` to target a non-default WSL distro
- `-WorkspacePath </path/in/wsl>` if your clone is not at `~/agorax`
- `-SessionName <name>` to use a custom tmux session name



### Verify the pairing

```bash
curl http://127.0.0.1:8642/health        # → {"status":"ok","platform":"hermes-agent"}
curl http://127.0.0.1:9119/api/status    # (optional) → {"status":"ok", ...}
```

Both must return `200`. If either fails, the workspace will fall back to **portable mode** (chat works, sessions/skills/memory show "Not Available").

### `.env` settings the workspace cares about

```env
# Required: where the gateway is
HERMES_API_URL=http://127.0.0.1:8642

# Optional: where the dashboard is (for analytics only)
# HERMES_DASHBOARD_URL=http://127.0.0.1:9119

# Only if your gateway was started with API_SERVER_KEY=... — paste the same value:
# HERMES_API_TOKEN=***

# Optional: password-protect the web UI itself
# HERMES_PASSWORD=***
```



### Common pairing scenarios


| Scenario                                     | Set this                                                                                                                               |
| -------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| Workspace + gateway on the same machine      | `HERMES_API_URL=http://127.0.0.1:8642` (optionally add `HERMES_DASHBOARD_URL` for analytics)                                           |
| Gateway on a remote server (Tailscale / VPN) | Set `HERMES_API_URL` to the reachable IP and add `API_SERVER_HOST=0.0.0.0` to the gateway's `~/.hermes/.env`                           |
| Already-running `hermes-agent`               | Just set `HERMES_API_URL` and skip the one-liner installer                                                                             |
| Multiple agent profiles                      | Profiles live under `~/.hermes/profiles/<name>` — see [API server & multi-profile gateways](#api-server--multi-profile-gateways) below |




### API server & multi-profile gateways

`API_SERVER_ENABLED` controls the OpenAI-compatible HTTP surface (`/health`, `/v1/models`, `/v1/chat/completions`, …) that Workspace pairs with.


| Usage                                                          | Need `API_SERVER_ENABLED=true`?           |
| -------------------------------------------------------------- | ----------------------------------------- |
| `hermes chat --tui` / classic CLI                              | No — uses `tui_gateway`, not `api_server` |
| Cron / kanban dispatcher only                                  | No                                        |
| Telegram / Discord / other messaging platforms                 | No — those are separate platform adapters |
| Workspace, Open WebUI, or any client calling `:8642` HTTP APIs | **Yes**                                   |


**Workspace pairing:** on localhost, Workspace lazy-starts **one API gateway per profile** on a stable port (default `:8642`, then `:8643`…). Switching the profile list only changes which port chat talks to — it does not restart other gateways. Point `HERMES_API_URL` at a remote host to keep single-gateway pairing. Swarm workers still use per-profile `HERMES_HOME` + tmux and do not go through this pool.

#### Multi-profile port conflicts

Every profile that sets `API_SERVER_ENABLED=true` defaults to port **8642**. Starting several `hermes -p <name> gateway run` processes without unique ports fails with `api_server_port_in_use`.

Workspace assigns a unique pool port and persists it into that profile's own `.env`. You can still pin a port yourself (env wins over YAML):

```env
# e.g. ~/.hermes/profiles/writer/.env
API_SERVER_ENABLED=true
API_SERVER_PORT=8649
API_SERVER_KEY=***
```

```yaml
# or in that profile's config.yaml
gateway:
  api_server:
    enabled: true
    port: 8649
    host: 127.0.0.1
```

Example port map (adjust as needed):


| Profile               | Port   |
| --------------------- | ------ |
| default (`~/.hermes`) | `8642` |
| architect             | `8643` |
| developer             | `8644` |


Disable the pool with `HERMES_GATEWAY_POOL=0` (remote `HERMES_API_URL` already disables it). Multiplex (`gateway.multiplex_profiles: true` on a shared listener) remains an alternative; see Hermes Agent docs.

### Live re-pairing (no restart)

If you've already started the workspace, change either URL from **Settings → Connection** without restarting. Values persist to `~/.hermes/workspace-overrides.json` and gateway capabilities are reprobed on save.

### Troubleshooting

- `Could not reach Hermes gateway on 8645, 8642, or 8643` — gateway isn't running, or `HERMES_API_URL` points somewhere unreachable. Run `hermes gateway run` and re-check.
- `api_server_port_in_use` **/ Port 8642 already in use** — more than one profile has `API_SERVER_ENABLED=true` without unique `API_SERVER_PORT`s. Disable API server on unused profiles, or assign distinct ports / use multiplex.
- **Workspace shows "portable mode" / extended APIs missing** — the gateway is not serving control-plane APIs. Verify `hermes gateway run` is up-to-date.
- **Sessions probe says unavailable / UI claims Offline but pairing should be live** — verify `curl http://localhost:6734/api/sessions` before starting another gateway. If it returns sessions (or an empty array), the backend pairing is alive and the UI needs a refresh/reprobe.
- **Chat send fails on Codex / OpenAI Codex models** — Codex CLI auth is stale. Run `codex login`, then retry the chat without starting another gateway.
- `Unauthorized` **on every API call** — gateway has `API_SERVER_KEY` set but workspace is missing `HERMES_API_TOKEN`. Match them.
- `Could not connect` **from your phone over Tailscale** — gateway is bound to loopback. Set `API_SERVER_HOST=0.0.0.0` in `~/.hermes/.env` and restart it.

---



## 🧠 Local Models (Ollama, Atomic Chat, LM Studio, vLLM)

Agorax supports two modes with local models:

### Portable Mode (Easiest)

Point the workspace directly at your local server — no Hermes Agent gateway needed.

### Atomic Chat

```bash
# Start workspace pointed at Atomic Chat
HERMES_API_URL=http://127.0.0.1:1337/v1 pnpm dev:ui
```

Download [Atomic Chat](https://atomic.chat/), launch the desktop app, and make sure a model is loaded before starting Agorax.

### Ollama

```bash
# Start Ollama
OLLAMA_ORIGINS=* ollama serve

# Start workspace pointed at Ollama
HERMES_API_URL=http://127.0.0.1:11434 pnpm dev:ui
```

Chat works immediately. Sessions, memory, and skills show "Not Available" — that's expected in portable mode.

### Enhanced Mode (Full Features)

Route through the Hermes Agent gateway for sessions, memory, skills, jobs, and tools.

Here are two explicit `~/.hermes/config.yaml` examples for the local providers we support directly in the workspace:

**Atomic Chat**

```yaml
provider: atomic-chat
model: your-model-name
custom_providers:
  - name: atomic-chat
    base_url: http://127.0.0.1:1337/v1
    api_key: atomic-chat
    api_mode: chat_completions
```

**Ollama**

```yaml
provider: ollama
model: qwen3:32b
custom_providers:
  - name: ollama
    base_url: http://127.0.0.1:11434/v1
    api_key: ollama
    api_mode: chat_completions
```

You can adapt the same shape for other OpenAI-compatible local runners, but `Atomic Chat` and `Ollama` are the two built-in local paths documented in the workspace UI.

**2. Enable the API server in** `~/.hermes/.env`**:**

```env
API_SERVER_ENABLED=true
```

**3. Start Agorax (and the gateway if needed):**

```bash
# One-shot local stack (gateway + managed-agent + UI)
HERMES_API_URL=http://127.0.0.1:8642 pnpm dev

# Or manual:
hermes gateway run          # :8642
hermes dashboard            # (Optional) :9119
HERMES_API_URL=http://127.0.0.1:8642 pnpm dev:ui
```

For authenticated gateways, also set `HERMES_API_TOKEN` in the workspace environment to the same value as `API_SERVER_KEY`.

All workspace features unlock automatically once the gateway is reachable.

> **Works with any OpenAI-compatible server** — Atomic Chat, Ollama, LM Studio, vLLM, llama.cpp, LocalAI, etc. Just change the `base_url` and `model` in the config above.

---



## 🐳 Docker Quickstart

![Open in GitHub Codespaces](https://img.shields.io/badge/GitHub%20Codespaces-Open-181717?logo=github)

The Docker setup runs both the **Hermes Agent gateway** and **Agorax** together.

### Prerequisites

- **Docker**
- **Docker Compose**
- **A configured Hermes Agent model provider** — run `hermes setup` / `hermes model`, or provide a key for whichever provider you use.



### Step 1: Configure Environment

```bash
git clone https://github.com/jingr1/agorax.git
cd agorax
cp .env.example .env
```

Edit `.env` and add **at least one** LLM provider key — whichever provider you want hermes-agent to use:

```env
# Pick one (or more). You do NOT need all of these.
# OPENAI_API_KEY=sk-...                # GPT / o-series / OpenAI-compatible
# OPENROUTER_API_KEY=sk-or-v1-...      # OpenRouter (free models available)
# GOOGLE_API_KEY=AIza...               # Gemini
```

Using **Ollama, LM Studio, or another local server**? No key needed — just point hermes-agent at your local endpoint via the onboarding flow.

> **Heads up:** `hermes-agent` needs to be able to reach *some* model. If you don't configure any provider (API key or local server), chat will fail on first message.



### Step 2: Start the Services

```bash
docker compose up
```

This pulls pre-built images and starts three services:

- **hermes-agent** → `nousresearch/hermes-agent:latest` on port **8642**
- **agorax** → `ghcr.io/outsourc-e/agorax:latest` on port **6734**
- **agorax-managed-agent** → same Agorax image, internal port **8788**

No local build. First run takes a minute to pull; subsequent starts are instant.
Agent state (config, sessions, skills, memory, credentials) persists in the
`hermes-agent-data` Docker volume, and the managed-agent DB lives alongside it
at `/home/workspace/.hermes/.agorax/agent.db`, so containers can be recreated
without data loss.

> **Managed runtimes (Claude Code / Codex / …):** the daemon service is included,
> but the actual provider CLIs are not bundled in the base image. To use them in
> Docker, install the CLI inside a custom image (e.g. `npm install -g @anthropic-ai/claude-code @openai/codex`) or run them on the host and point
> the workspace at the host daemon with `AGORAX_MANAGED_AGENT_URL`.



### Step 3: Access the Workspace

Open `http://localhost:6734` and complete the onboarding.

> **Verify:** Check the Docker logs for `[gateway] Connected to Hermes Agent` — this confirms the workspace successfully connected to the agent.



### Remote Access (LAN / Tailscale / VPN)

The default compose file binds ports to `127.0.0.1` (localhost only). To access the workspace from other devices on your network, you need to:

**1. Publish ports without the loopback restriction.** Create a `docker-compose.override.yml`:

```yaml
services:
  hermes-agent:
    ports:
      - '8642:8642'
  agorax:
    ports:
      - '6734:6734'
```

**2. Add these env vars to** `.env`**:**

```env
# Required: workspace session password (the workspace refuses to start on 0.0.0.0 without it)
HERMES_PASSWORD=your-strong-secret-here

# Required for plain-HTTP LAN access (browsers drop Secure cookies over http://)
COOKIE_SECURE=0

# Recommended: gateway auth token (prevents unauthenticated API access on your LAN)
API_SERVER_KEY=***

# If the gateway refuses to start with "No user allowlists configured":
GATEWAY_ALLOW_ALL_USERS=true
```

**3. Restart the stack:**

```bash
docker compose down && docker compose up -d
```

> **HTTPS behind a reverse proxy?** If you terminate TLS at a reverse proxy (Traefik, Nginx, Caddy, Tailscale Funnel), set `COOKIE_SECURE=1` instead and add `TRUST_PROXY=1` so IP classification works correctly.



### Troubleshooting Docker


| Symptom                                                                      | Fix                                                                                                                                                |
| ---------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| `[workspace] refusing to start — HERMES_PASSWORD is unset`                   | Add `HERMES_PASSWORD=<secret>` to `.env`                                                                                                           |
| Login silently fails (no error, page reloads)                                | Add `COOKIE_SECURE=0` for HTTP, or `COOKIE_SECURE=1` + HTTPS                                                                                       |
| `[Api_Server] Refusing to start: binding to 0.0.0.0 requires API_SERVER_KEY` | Add `API_SERVER_KEY=***` to `.env`                                                                                                                 |
| `No user allowlists configured. All unauthorized users will be denied.`      | Add `GATEWAY_ALLOW_ALL_USERS=true` to `.env`                                                                                                       |
| `HERMES_DASHBOARD_TOKEN is not set` warning                                  | Set `HERMES_DASHBOARD_TOKEN` to the same value as `API_SERVER_KEY`                                                                                 |
| Managed agents show "daemon unreachable"                                     | Check `docker compose logs agorax-managed-agent`; verify `AGORAX_MANAGED_AGENT_URL=http://agorax-managed-agent:8788` inside the `agorax` container |
| 500 Internal Server Error on login after setting all the above               | Clear browser cookies for the workspace domain, then retry                                                                                         |




### Building from source

Use the dev overlay:

```bash
docker compose -f docker-compose.yml -f docker-compose.dev.yml up --build
```

The base `docker-compose.yml` stays untouched — the overlay adds a `build:`
block for the `agorax` service so the local repo is compiled
instead of pulled. The overlay also builds the `agorax-managed-agent`
Go daemon from `agorax-agent-daemon/` into the same image.

### Build the image manually

```bash
docker build -t agorax .
```

The Dockerfile is multi-stage: it compiles the `agorax-managed-agent` Go
daemon, installs Node dependencies, runs `pnpm build`, and copies only
the runtime artefacts into the final `node:22-slim` image. To build for a
managed-agent-only change without rebuilding the entire UI, target the
`daemon-build` stage:

```bash
docker build --target daemon-build -t agorax-daemon .
```



### Using a Pre-Built Image (Coolify / Easypanel / Dokploy / Unraid)

Pull the image directly from GitHub Container Registry:

```
ghcr.io/outsourc-e/agorax:latest
```

Available tags:


| Tag          | What it is                                 |
| ------------ | ------------------------------------------ |
| `latest`     | Latest `main` commit (stable; recommended) |
| `v2.0.0`     | Pinned semver tag                          |
| `main-<sha>` | Specific commit                            |


Minimal Coolify / Easypanel config:

```yaml
service: agorax
image: ghcr.io/outsourc-e/agorax:latest
port: 6734
env:
  HERMES_API_URL: http://hermes-agent:8642 # point at your gateway
  HERMES_API_TOKEN: ${API_SERVER_KEY} # if gateway auth is enabled
  AGORAX_MANAGED_AGENT_URL: http://agorax-managed-agent:8788 # managed runtimes
```

The image is built for `linux/amd64` and `linux/arm64`. Pair it with either
a `nousresearch/hermes-agent:latest` container or an existing gateway on another host. If you use managed
runtimes, deploy the same Agorax image a second time as the managed-agent
daemon with command `['/usr/local/bin/agorax-agentd']` and the same
`/home/workspace/.hermes` and `/workspace` volumes.

---



## 📱 Install as App (Recommended)

Agorax is a **Progressive Web App (PWA)** — install it for the full native app experience with no browser chrome, keyboard shortcuts, and offline support.

### 🖥️ Desktop (macOS / Windows / Linux)

1. Open Agorax in **Chrome** or **Edge** at `http://localhost:6734`
2. Click the **install icon** (⊕) in the address bar
3. Click **Install** — Agorax opens as a standalone desktop app
4. Pin to Dock / Taskbar for quick access

> **macOS users:** After installing, you can also add it to your Launchpad.



### 📱 iPhone / iPad (iOS Safari)

1. Open Agorax in **Safari** on your iPhone
2. Tap the **Share** button (□↑)
3. Scroll down and tap **"Add to Home Screen"**
4. Tap **Add** — the Agorax icon appears on your home screen
5. Launch from home screen for the full native app experience



### 🤖 Android

1. Open Agorax in **Chrome** on your Android device
2. Tap the **three-dot menu** (⋮) → **"Add to Home screen"**
3. Tap **Add** — Agorax is now a native-feeling app on your device

---



## 📡 Mobile Access via Tailscale

Access Agorax from anywhere on your devices — no port forwarding, no VPN complexity.

### Setup

1. **Install Tailscale** on your Mac and mobile device:
  - Mac: [tailscale.com/download](https://tailscale.com/download)
  - iPhone/Android: Search "Tailscale" in the App Store / Play Store
2. **Sign in** to the same Tailscale account on both devices
3. **Find your Mac's Tailscale IP:**
  ```bash
   tailscale ip -4
   # Example output: 100.x.x.x
  ```
4. **Open Agorax on your phone:**
  ```
   http://100.x.x.x:6734
  ```
5. **Add to Home Screen** using the steps above for the full app experience

> 💡 Tailscale works over any network — home wifi, mobile data, even across countries. Your traffic stays end-to-end encrypted.

---



## 🖥️ Native Desktop App

Agorax also ships an **Electron** desktop wrapper. Build it from source:

```bash
pnpm electron:build     # current platform
pnpm electron:build:mac # macOS
pnpm electron:build:win # Windows
```

The PWA install path above is the fastest way to get a native-feeling desktop experience today; Electron is available for users who want a standalone binary.

---



## 🔒 Security & deployment env vars

Key safeguards — most are on by default, the env vars below are for remote / Docker deployments where you opt out of the loopback default.

### Built-in safeguards

- Auth middleware on every API route
- CSP headers via meta tags
- Path-traversal prevention on file/memory routes (real-path boundary check, not string prefix)
- Rate limiting on endpoints
- Fail-closed startup guard: refuses to bind non-loopback without `HERMES_PASSWORD`
- Session cookies: `HttpOnly` + `SameSite=Strict` + `Secure` (in production)
- Optional password protection for the web UI



### Env vars for remote / Docker deployments

- `HERMES_PASSWORD` — required whenever `HOST ≠ 127.0.0.1` (legacy `CLAUDE_PASSWORD` still honored as a fallback)
- `COOKIE_SECURE=1` — force the `Secure` cookie flag when terminating HTTPS at a proxy
- `COOKIE_SECURE=0` — disable the `Secure` flag for plain-HTTP LAN deployments (`HOST=0.0.0.0` without HTTPS); without this, browsers silently drop session cookies and login fails
- `TRUST_PROXY=1` — trust `x-forwarded-for` / `x-real-ip` (only set behind a sanitizing reverse proxy)
- `HERMES_DASHBOARD_TOKEN` — explicit bearer for dashboard API
- `HERMES_API_TOKEN` — bearer for the Hermes Agent gateway when started with `API_SERVER_KEY` (legacy `CLAUDE_API_TOKEN` still honored)
- `HERMES_ALLOW_INSECURE_REMOTE=1` — bypass the fail-closed guard (not recommended)

See `.env.example` for the full list.

---



## 🔧 Troubleshooting



### "Workspace loads but chat doesn't work"

The workspace auto-detects your gateway's capabilities on startup. Check your terminal for a line like:

```
[gateway] http://127.0.0.1:8642 available: health, models; missing: sessions, skills, memory, config, jobs
[gateway] Missing Hermes Agent APIs detected. Update hermes-agent to the latest version.
```

**Fix:** Upgrade to the latest `hermes-agent`:

```bash
cd ~/hermes-agent && git pull && uv pip install -e .
hermes gateway run
```

If you were on a pre-v2 setup, follow the current install instructions above.

### "Connection refused" or workspace hangs on load

Your Hermes Agent gateway isn't running. Start it:

```bash
hermes gateway run
```

First-time run? Do `hermes setup` first to pick a provider and model.

### Ollama: chat returns empty or model shows "Offline"

Make sure your `~/.hermes/config.yaml` has the `custom_providers` section and `API_SERVER_ENABLED=true` in `~/.hermes/.env`. See [Local Models](#-local-models-ollama-lm-studio-vllm) above.

Also ensure Ollama is running with CORS enabled:

```bash
OLLAMA_ORIGINS=* ollama serve
```

Use `http://127.0.0.1:11434/v1` (not `localhost`) as the base URL.

Verify: `curl http://localhost:8642/health` should return `{"status": "ok"}`.

### Docker: "Unauthorized" or "Connection refused" to hermes-agent

If using Docker Compose and getting auth errors:

1. **Check at least one provider key is set:**
  ```bash
   grep -E '_API_KEY' .env
   # Should show one of: OPENAI_API_KEY, OPENROUTER_API_KEY, GOOGLE_API_KEY, or another provider key you intentionally use.
  ```
2. **View the agent container logs:**
  ```bash
   docker compose logs hermes-agent
  ```
3. **Verify the agent health endpoint:**
  ```bash
   curl http://localhost:8642/health
   # Should return: {"status":"ok"}
  ```
4. **Restart with fresh containers:**
  ```bash
   docker compose down
   docker compose up --build
  ```
5. **Check workspace logs for gateway status:**
  ```bash
   docker compose logs agorax
  ```
   Look for: `[gateway] http://hermes-agent:8642 mode=...` — if it shows `mode=disconnected`, the agent isn't running correctly.

---



## ⭐ Star History



## ![Star History Chart](https://api.star-history.com/svg?repos=jingr1/agorax&type=date&logscale&legend=top-left)



## 💛 Support the Project

Agorax is free and open source. If it's saving you time and powering your workflow, consider supporting development:

![GitHub Sponsors](https://img.shields.io/badge/Sponsor-%E2%9D%A4-pink?logo=github)
![Star jingr1/agorax](https://img.shields.io/github/stars/jingr1/agorax?style=social)

Every contribution helps keep this project moving. Thank you 🙏

---



## 🤝 Contributing

PRs are welcome! See [CONTRIBUTING.md](CONTRIBUTING.md) for guidelines.

- Bug fixes → open a PR directly
- New features → open an issue first to discuss
- Security issues → see [SECURITY.md](SECURITY.md) for responsible disclosure

---



## 🙏 Acknowledgments

Agorax stands on the shoulders of these projects:


| Project                                                            | Repository                                                                                       |
| ------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------ |
| [Tutti](https://github.com/tutti-os/tutti)                         | [https://github.com/tutti-os/tutti](https://github.com/tutti-os/tutti)                           |
| [Hermes WebUI](https://github.com/nesquena/hermes-webui)           | [https://github.com/nesquena/hermes-webui](https://github.com/nesquena/hermes-webui)             |
| [Multica](https://github.com/multica-ai/multica)                   | [https://github.com/multica-ai/multica](https://github.com/multica-ai/multica)                   |
| [Hermes Workspace](https://github.com/outsourc-e/hermes-workspace) | [https://github.com/outsourc-e/hermes-workspace](https://github.com/outsourc-e/hermes-workspace) |


Thank you to their authors and communities.

---



## 📄 License

MIT — see [LICENSE](LICENSE) for details.

---

Built with ⚡ by [@jingr1](https://github.com/jingr1) and the Agorax community