# Changelog

All notable changes to Agorax are documented here.
The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [Unreleased]

## [2.5.0] — 2026-09-09

### Added

- **Multi-Agent Workspace** — Mission Control, pipelines API, `agents.yaml` runtime declarations, and task-pipeline dispatch split (Hermes vs managed runtimes)
- **Group chat rooms** — room workspace dual-mode (ad-hoc sticky path + mission-derived worktree/repo path), `ensureRoomForMission`, turn cwd wiring
- **Claude Code managed chat** — print-mode adapter with MCP handshake, model/effort picker, localStorage sessions, stream-json partial output
- **Managed companion tooling** — skip-permissions for non-interactive runs; ThinkingBubble live tool activity without transcript spam
- **Excalidraw + Mermaid** embeds in markdown rendering

### Changed

- Claude Code chat prompt defaults user-facing narration to 简体中文
- Agent switch restores last Claude Code / managed session (parity with Hermes profile last-session)
- Composer clears draft after managed send (matches Hermes `helpers.reset()`)

### Fixed

- Claude Code landing on blank “New Chat” when switching agents (AgentList/session URL race)
- Managed composer retaining text after Enter
- Tool-call progress flooding the assistant bubble instead of status chrome

## [2.4.0] — 2026-08-23

### Added

- **Mobile voice input with local STT** — record on phone, transcribe via Mac faster-whisper (`stt.provider: local`); HTTPS/Tailscale remote access support
- **STT status + transcribe API** — `/api/stt-status` and `/api/transcribe` with local Whisper, Groq, and OpenAI providers
- **LangGraph orchestrator** — workflow-driven routing, checkpoints, and human-gate integration
- **Swarm orchestration upgrades** — checkpoint sync, stream handoff, worker runtime state, profile gateway pool
- **Workspace folder management** — caching, preload, and sidebar file explorer improvements
- **Provider catalog + OAuth modals** — Codex and Anthropic login flows; expanded provider management
- **Context usage tracking** — composer and chat session context bar
- **Job delivery targets API** — multi-target cron delivery support
- **better-sqlite3** — SQLite handling for workspace data paths

### Changed

- **Chat composer** — mic/stop button mutual exclusion, mobile touch handling, remote streaming abort fixes
- **Swarm configuration** — runtime model handling and profile sync improvements
- **Markdown rendering** — KaTeX math, enhanced code block handling

### Fixed

- Mobile microphone permissions and insecure-context detection over Tailscale HTTPS
- Chat streaming tab-switch and new-chat state blocking
- Gateway capability probing and profile-scoped config reads for split-host deployments

## [2.3.0] — 2026-06-05

### Added

- HermesWorld v1 embed, Echo Studio Labs scaffold, Agent Bus panel, and overnight shakedown fixes (see git history for full list)

### Changed

- **`docker compose up` now pulls pre-built images by default** (#82) — `nousresearch/hermes-agent:latest` for the gateway and `ghcr.io/outsourc-e/hermes-workspace:latest` for the UI. Agent state persists in the `claude-data` named volume. Adds `docker-compose.dev.yml` overlay for building from source.

## [2.0.0] — 2026-04-20

**Zero-fork release.** Clone, don't fork. Agorax now runs on vanilla `pip install hermes-agent` with no patches, no drift, no custom gateway required.

### Added

- **Zero-fork architecture** — dual gateway/dashboard routing; workspace talks directly to vanilla `hermes-agent` 0.10.0+ via standard endpoints (`/v1/models`, `/api/sessions`, `/api/skills`, `/api/config`, `/api/jobs`)
- **One-liner curl installer** — `curl -fsSL … | bash` provisions workspace + gateway + defaults
- **Claude-Nous theme** — dark + light editorial variants with cobalt/paper surface pass, thin 1px architectural borders, editorial type accents
- **Conductor** (`/conductor`) — mission-control surface ported from Clawsuite; spawn missions, assign workers, watch live output and costs
- **Operations** (`/operations`) — agent registry / sessions manager ported from Clawsuite; pause, steer, kill live agents with role and model insight
- **Synthesized tool pills** — inline tool-call rendering from dashboard stream markers when running against zero-fork gateway
- **Landing parity pass** — hero, features, screenshots, setup, OG image, mobile theme toggle
- **Task board status vs. assignee** decoupling
- **Local-model chat session persistence** — local sessions appear in history + session list
- **Memory is local-fs first** — honors `HERMES_HOME`, no gateway dependency
- **Splash + screenshots refresh** — Conductor, Dashboard, Tasks, Jobs captured in new editorial theme

### Changed

- **Model picker** — fetches from gateway (`~/.hermes/models.json` for user-configured models), matches OCPlatform behavior; shows only configured providers instead of all upstream
- **`enhanced-fork` mode label** no longer implies a fork is required; it indicates streaming route availability on vanilla gateway
- **Dashboard + enhanced-chat capabilities** marked optional; missing endpoints no longer trigger warnings
- **Feature-gate + install copy** — all fork-era references purged
- **Theme family allowlist** — `claude-nous` promoted to the enterprise allowlist
- **Session pill** — solid dark-mode background, matches model selector

### Fixed

- Duplicate responses and disappearing history on interrupt (#62)
- Portable-mode double user message, uncleaned timeouts, orphaned unregister callbacks
- Local model selection actually propagates to chat (no silent fallback)
- Strip provider prefix correctly for local routing
- Dashboard token injection on `/` (not `/index.html`)
- Onboarding no longer stacks behind workspace shell
- Root bootstrap guards against uncaught errors
- Preserve assistant text during tool-call streaming
- Installer output uses defined escape vars (removed undefined BOLD/RESET)

### Removed

- All references to the legacy "enhanced fork" as a requirement
- Stale fork-era gateway instructions and feature-gate copy

---

## [1.0.0] — 2026-04-10

Initial public release. Chat, files, memory, skills, terminal, dashboard, settings — the foundational workspace.
