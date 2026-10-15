# Agent model catalog

`modelcatalog` owns the provider-neutral model capability contract shared by
Agent runtime adapters and their product hosts. It normalizes provider model
catalogs, projects those catalogs into runtime `configOptions`, and parses the
same descriptors back without losing per-model reasoning, speed, or input
capabilities.

Provider runtimes are responsible for publishing complete model descriptors.
Hosts such as `agorax-agentd` and TSH's `desktopd` consume
`ParseRuntimeConfigOptionModels`; they must not copy provider-specific parsing
or infer missing capabilities. Process launch, transport, live-session lookup,
and caching remain responsibilities of each host adapter.

Local composer-options (`LoadLocalProviderModels`) covers:

- Claude Code → `~/.claude/settings.json`
- Codex → `~/.codex/config.toml`
- OpenCode → OpenCode's own catalog, in order:
  1. running service `GET /api/model` (Basic auth from `~/.config/opencode/service.json`)
  2. `opencode --log-level none api GET /api/model`
  3. `opencode --log-level none models`
  Results are cached for 5 minutes. Model ids stay `providerID/modelID`
  exactly as OpenCode addresses them.

Field presence is part of the contract. An advertised empty capability list
means that the provider explicitly does not support that capability, while a
missing field means that the provider did not advertise it.
