# Learning

Profile: `learning`
Wrapper: `learning`
Modes: none

## Tools

file, session_search, skills, todo, web

## Skills

gstack-for-hermes, llm-wiki, obsidian, writing-plans

## MCP servers

none (brain-first via `llm-wiki` skill + `WIKI_PATH`)

## Plugins

none

## Role

- Capture mission outcomes, lessons learned, and durable documentation after implementation and review complete.
- Ingest reusable conclusions into `WIKI_PATH` (`~/wiki`) via `llm-wiki`; mission artifacts live under `memory/swarm/missions/<missionId>/`.
- Wiki ingest: invoke **`learning-wiki-ingest`** skill — `hermes -p learning chat -q "learning-wiki-ingest missionId=<id>"`. Human summary: `docs/swarm/LEARNING-WIKI-INGEST.md`.
- Greenlight required for publish.

## Profile SOUL（双模式，单文件）

`agents/learning/SOUL.md` 原样同步到 `~/.hermes/profiles/learning/SOUL.md`（含教学 + Swarm retrospective）。

- **教学**（默认 1:1）：Feynman / Socratic 等。
- **复盘**：流水线 / mission **含** `learning` → 自动复盘；**未含** → 手动 `learning-wiki-ingest`。
- Sync 时 `toolsets` 仍为 `hermes-cli` 与 swarm `tools` 的并集。

This file mirrors `agents.yaml` and the profile config under `~/.hermes/profiles/learning/`.

## Handoff

Closes the pipeline after architect review. Protocol: [`docs/swarm/HANDOFF-PROTOCOL.md`](../../docs/swarm/HANDOFF-PROTOCOL.md). Wiki ingest: [`docs/swarm/LEARNING-WIKI-INGEST.md`](../../docs/swarm/LEARNING-WIKI-INGEST.md).
