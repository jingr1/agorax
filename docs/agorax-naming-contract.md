# Agorax Naming Contract

This repo is for **Agorax** — the public square for AI agents — built on the **Hermes Agent** runtime.

## Canonical product names

Use these in all new UI, docs, skills, prompts, tests, review comments, and handoffs:

- **Agorax** — the product (UI titles, PWA manifest, package name, Electron app, Docker image, docs)
- **Hermes Agent** — the runtime that powers Agorax (gateway, profiles, CLI)
- **Swarm** — the multi-agent engine
- **HERMES_HOME**, `~/.hermes` — runtime paths (unchanged contracts)

## Forbidden new references

Do **not** introduce these in new work unless quoting legacy history or compatibility behavior:

- **Hermes Workspace** — the former product name (legacy only)
- **hermes-workspace** — the former package/image/slug (legacy only; the GitHub repo path `outsourc-e/hermes-workspace` stays until the repo itself is renamed)
- Claude-branded product names, paths, or wrapper guidance

## Runtime/path rules (unchanged)

- `HERMES_HOME`, `~/.hermes/profiles/<workerId>` remain the canonical runtime paths — do not invent Agorax-branded profile paths.
- `HERMES_*` / `AGORAX_*` env vars are wire contracts between Agorax, the Hermes runtime, and the LangGraph orchestrator — do not rename or alias them without a migration plan.
- Worker/tmux session naming (`swarm-<workerId>`), `swarm.yaml`, and `agents.yaml` are engine-level identifiers — user-visible labels change via UI copy/i18n only.

## Reviewer rule

Any PR or patch that:

- introduces "Agorax" as a **product name** in new UI/docs, or
- renames runtime contract terms (env vars, profile paths, session naming)

should be treated as a regression unless it is a legacy compatibility note or a migration doc.

## Agent instruction rule

When an agent is working in this repo:

- assume **Agorax** is the product name and **Hermes Agent** is the runtime name
- keep Hermes runtime terminology exactly where it denotes a runtime contract
- do not invent new Agorax-branded paths, env vars, or wrapper guidance
- if uncertain, prefer repo-native Hermes runtime terminology over historical aliases
