# Agent Activity Daemon Adapter

Monorepo-private mapping between the **Agorax agent daemon** REST wire DTOs
and the canonical `@agorax/agent-activity-core` entities.

The daemon (`agorax-agent-daemon`, Agorax managed-agent daemon) emits
its canonical entities as Go `encoding/json` struct dumps, so response fields
are the PascalCase Go field names (`ID`, `ActiveTurnID`, `CreatedAtUnixMS`,
…). `src/daemonDtos.ts` is the hand-maintained DTO truth source and mirrors
the daemon Go structs; it replaces the generated `generated daemon client`
client the source package consumed. When the daemon structs change, update
`daemonDtos.ts` and the key-set assertions in `daemonDtos.test.ts` together.

## Relationship to `@agorax/agent-activity-core`

All activity-core imports in this package are `import type`: the mappers are
type-erased at runtime, so `node --test --experimental-strip-types` runs the
test suite without any workspace linking. The dependency is declared in
`package.json` (`workspace:*`) for consumers and for a future value-level
helper import.

## Scope

- `mappers.ts` — canonical Session/Turn/Message/Interaction projections with
  daemon contract validation. Fields the daemon does not project
  (permissionConfig, lifecycleCapabilities, forkedFrom, goalSyncState,
  agoraxModeActivation, …) receive explicit defaults or `null`, mirroring the
  daemon's actual JSON.
- `sessionDetail.ts` — one-aggregate mapper for `GET .../activity`
  (`{workspaceId, session, turns, messages, interactions}`) into the core
  detail snapshot plus the message/interaction collections. Validation is
  atomic: a mismatched root id or a foreign-owned Turn/Message/Interaction
  fails the whole aggregate.
- `requests.ts` — outbound create-session and send-input projections. Only
  fields the daemon decode structs accept cross the HTTP boundary; local
  prompt fields (`uri`, `hostPath`, `uploadStatus`, `assetId`) never do.
- `capabilityReferences.ts` — capability-ref contract guards (activity-core
  vocabulary: `agorax` + `slash_command`).
- `composerOptions.ts` / `composerSettings.ts` —
  **deprecated, TODO(daemon-endpoint)**: the daemon has no composer routes
  yet. Kept from the daemon adapter so the canonical projections survive the
  port; their response/request contracts live in `daemonDtos.ts` and mirror
  the generated daemon shapes until the daemon endpoint lands.

Dropped from the source package: `goalControl.ts` and mode-
activation mapper — the daemon REST surface exposes no goal-control or mode
routes, and this package adds no mappings for daemon-absent contracts.

## Tests

```bash
node --test --experimental-strip-types "./src/**/*.test.ts"
```

(Node 22+; from this directory. `daemonDtos.test.ts` asserts the DTO key
sets against the daemon Go structs for the session/turn/message/interaction
entities.)

## DTO truth sources (daemon Go)

- REST handlers and request decode structs:
  `agorax-agent-daemon/packages/agent/daemon/cmd/agorax-agentd/main.go`
- Canonical entities: `agorax-agent-daemon/packages/agent/store-sqlite/repository.go`
- Session metadata/usage/goal: `agorax-agent-daemon/packages/agent/store-sqlite/session_metadata.go`
- Host results (create/send/cancel/interactive): `agorax-agent-daemon/packages/agent/host/types.go`
