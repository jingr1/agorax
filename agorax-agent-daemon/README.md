# Agorax Agent Daemon Core

This directory is the in-repository migration boundary for the Agent Host and
managed runtime code for Agorax's local agent Host (Session / Turn / activity).

## Migrated core

- `packages/agent/host`: canonical Session/Turn/Interaction lifecycle
- `packages/agent/store-sqlite`: durable canonical state
- `packages/agent/store-sqlite/canonical`: shared identity and state contracts
- `packages/agent/activity-replication`: activity replication primitives
- `packages/agent/session-replay`: replay and provider history contracts
- `packages/connector/daemon/core`: connector runtime core
- `packages/events/stream-go`: event stream transport primitives
- Claude Code is hosted by the daemon's CLI adapter using the local Claude CLI.
  The Workspace does not launch a fallback Claude process.

The Go modules use the local vanity path `agorax.local/agent-daemon/...`.
This is a logical module identity, not a GitHub or network endpoint. The
workspace file maps it to the local `agorax-agent-daemon` directory, so the Go
code is not coupled to the repository hosting URL.

## Composition

`packages/agent/daemon/cmd/agorax-agentd` composes the SQLite canonical store,
Go Host, runtime controller, providers and durable activity reporter. It exposes
health, provider status/catalog, Session/input/cancel, interaction and activity
interfaces used by the Workspace.

Session and Turn lifecycle is owned by Go Host. Product Missions, room scheduling
and workflow human gates remain Workspace concerns. The boundary and current
coverage are documented in [daemon mapping](../docs/managed-agent-daemon-mapping.md).

The development composition is available from the Agorax repository root:

```bash
pnpm dev:managed-agent
```

`pnpm dev` starts the Hermes gateway, Agorax WebUI, and this embedded
daemon together. The WebUI uses `AGORAX_MANAGED_AGENT_URL` and
`AGORAX_WORKSPACE_ID` to route Claude Code, Codex, Cursor, OpenCode, and Kimi
through the embedded Managed Agent bridge.

The Claude SDK sidecar is not part of this migration. Do not install
`@anthropic-ai/claude-agent-sdk`; use the Agorax CLI adapter instead.

The embedded daemon is the managed execution path, not a probe-only stub.
Transport contract tests complement Go Host tests; neither alone proves a real
provider login or external CLI behavior.

## Validation

The intended validation command after Go is available is:

```bash
GOWORK=$PWD/go.work go test ./packages/agent/host/... ./packages/agent/store-sqlite/... ./packages/agent/activity-replication/...
```

The Go toolchain is installed in the development environment and the migrated
Go modules have been tested individually through the workspace.
