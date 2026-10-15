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
- Claude Code is intentionally excluded from the Go runtime migration. Agorax
  uses the existing TypeScript `claude -p --output-format stream-json` adapter
  for Claude Code, the same CLI boundary used by the other managed backends.

The Go modules use the local vanity path `agorax.local/agent-daemon/...`.
This is a logical module identity, not a GitHub or network endpoint. The
workspace file maps it to the local `agorax-agent-daemon` directory, so the Go
code is not coupled to the repository hosting URL.

## Remaining work

`packages/agent/daemon` is copied as source and points at the migrated local
dependencies. A minimal Agorax composition root is available at
`packages/agent/daemon/cmd/agorax-agentd`; it exposes `/health` and the initial
Agent target probe endpoint.

The embedded daemon now exposes Session creation, Input, Turn cancel, and the
canonical activity WebSocket. The remaining higher-level work is interactive
approval/question response, full history paging, and recovery/reconciliation UI.

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

Until the full API/event wiring is complete, the embedded daemon should only be
used for local composition and health checks. The TypeScript Managed Agent
transport remains the contract test surface for the unfinished endpoints.

## Validation

The intended validation command after Go is available is:

```bash
GOWORK=$PWD/go.work go test ./packages/agent/host/... ./packages/agent/store-sqlite/... ./packages/agent/activity-replication/...
```

The Go toolchain is installed in the development environment and the migrated
Go modules have been tested individually through the workspace.
