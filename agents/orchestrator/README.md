# Orchestrator

Profile: `orchestrator`
Wrapper: `orchestrator:plan`
Modes: plan, autoresearch, autoresearch-dispatch

## Tools

todo, kanban, delegation, terminal, file, session_search, cronjob, skills, clarify, web

## Skills

orchestrator-core, gstack-for-hermes, llm-wiki, kanban-orchestrator, subagent-driven-development, writing-plans, autoresearch, autoresearch-plan, autoresearch-orchestrate

## MCP servers

none (brain-first via `llm-wiki` skill + `WIKI_PATH`)

## Plugins

none

## Autoresearch

- `orchestrator:autoresearch` — **default entry** (Claude `/autoresearch` equivalent): wizard → contract → dispatch executor
- `orchestrator:autoresearch-dispatch` — validate existing contract only, then dispatch
- Executors: `architect:autoresearch` | `developer:autoresearch`

Docs: `docs/swarm/AUTORESEARCH-GUIDE.md`. Install: `bash scripts/sync-autoresearch-skills.sh`

This file mirrors `swarm.yaml` and the profile config under `~/.hermes/profiles/orchestrator/`.
