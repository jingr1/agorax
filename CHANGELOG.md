# Changelog

All notable changes to Agorax are documented here.
The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [Unreleased]

## [1.0.0] — 2026-10-16

First public release of **Agorax** — the agora for AI agents.

### Features

- **Chat** — 1:1 Hermes profile chat and managed companions (Claude Code, Codex, Cursor, OpenCode, Kimi, …)
- **Missions & Agents** — mission control, unified `agents.yaml` registry (Hermes + managed runtimes)
- **Group chat** — multi-agent rooms with sticky or mission-derived workspace
- **Swarm / LangGraph** — multi-worker pipelines, checkpoints, human gates, tmux delivery
- **Hermes gateway** — multiplex (`/p/<profile>` on one host) with per-port pool fallback
- **Memory** — Hermes `memories/` + profile `SOUL.md` in the Memory UI; knowledge / wiki browsing
- **Skills & MCP** — platform skill library and per-agent MCP bindings (Hermes + managed)
- **Files, Terminal, Dashboard, Settings** — local workspace shell around Hermes and companions
- **Install** — `install.sh` seeds `agents.yaml` from `agents.yaml.example` and ensures Swarm profiles
