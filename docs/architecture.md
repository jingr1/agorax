# Agorax Architecture Contract

Agorax is a local-first control plane with two execution tracks, not a single
provider runtime. The Workspace owns product orchestration; execution owners
retain their native Session and Turn lifecycle.

## Ownership

| Domain | Authoritative storage | Writer | Recovery |
| --- | --- | --- | --- |
| Agent identity and runtime declaration | Local `agents.yaml`; example is the installation template | Registry API | Reload registry; never interpret a managed id as a Hermes profile |
| Mission and Assignment | JSON repository by default; `collab.db` when `AGORAX_MISSION_SQLITE_SOT=1` | MissionRepository | Read the selected repository; do not treat an export as canonical |
| Managed Session, Turn, Interaction | Daemon `agent.db` | Go Agent Host through daemon APIs | Canonical activity snapshot and history reconciliation |
| Hermes Session and message history | Profile Gateway/session store | Hermes Gateway | Stable native bridge identity mapping and history repair |
| Hermes engine identity mapping | `collab.db` `agorax_run_mapping` | Native bridge APIs | Resolve the exact Session/Turn/run; unknown mapping is not success |
| Mission MCP run and run-token ledger | `collab.db` `task_runs` / `run_tokens` | MCP control channel | Reconcile against Assignment and runtime; do not infer completion from process exit alone |
| Dispatch lease | `collab.db` `control_plane_leases` | Shared scheduler admission | Owner/token fencing; expiry does not authorize replay |
| Pending dispatch and retry deadline | `collab.db` `control_plane_state` scheduler namespaces | Scheduler | Restore exact Assignment identity, attempt and deadline; recheck dependency and terminal state |
| Room transcript, participants, watermarks | `collab.db` room tables | Group-chat domain | Resume observation; only a human send ignites a new bounded drive |
| Room stops, epoch, in-flight and stranded markers | `collab.db` `control_plane_state` room namespace | Room runner | Restore stops and unresolved turns; never expire a recovered unknown turn into a fresh send |
| Skills / MCP library and bindings | `collab.db` platform and binding tables | Capability services | Materialize Hermes profile artifacts; managed adapters inject bindings without a Hermes profile |
| LangGraph workflow checkpoint | LangGraph checkpoint SQLite | Python workflow | Resume explicit workflow / human gate; it is not the Session/Turn ledger |

`default` is a first-class Hermes Agent whose home is the root Hermes home.
`dispatchable: false` excludes workflow dispatch, not capability bindings.

## Execution Boundaries

- HTTP routes authenticate, validate and serialize. Application execution lives
  in server services, including [Swarm dispatch](../src/server/swarm-dispatch-service.ts).
- Managed providers delegate canonical lifecycle to Go Host. The Node bridge
  owns transport subscriptions, not a second Session/Turn state machine.
- Both chat tracks project through Activity Core and Session Engine. Runtime
  protocols stop at their adapters. See [Native Bridge](hermes-native-bridge.md)
  and [daemon mapping](managed-agent-daemon-mapping.md).
- Assignment readiness, review and human gates precede dispatch admission.
  Capacity does not override them. See [Mission contract](mission-task-domain.md).

## Startup and Shutdown

[Server entry](../src/server-entry.ts) initializes
[bootstrap](../src/server/bootstrap.ts) before serving requests. Bootstrap owns
the room runner, scheduler and Skills synchronization timers and configures
their durable control store. Route imports have no startup responsibility.

The production HTTP host explicitly initializes the entry, closes its own
listeners on SIGINT/SIGTERM, and drains for up to five seconds. Existing Gateway
and daemon processes are external: Workspace shutdown does not terminate them.
The stack launcher owns newly started foreground children. The managed launcher
validates daemon health identity, does not silently replace a stale listener,
and only replaces a daemon when `--force` is explicitly supplied.

`AGORAX_ENV_FILE` selects an explicit production environment file; otherwise the
project `.env` is required. This permits isolated trials without reading live
credentials. After `pnpm build`, `pnpm test:control-plane` starts/stops the real
production HTTP server twice with a temporary home/database/environment and
checks readiness and preservation of stop intent and unresolved leases.

Gateway readiness and canonical execution readiness are separate. A reachable
Gateway is not evidence that a Turn completed. Daemon health identifies the
runtime; provider status/catalog endpoints report individual provider readiness.

## Storage and Subscriptions

SQLite Mission writes commit product state without a synchronous JSON scan.
`SqliteMissionRepository.exportToJson()` explicitly exports a complete snapshot,
independent of the 100-row list page cap. List endpoints use summary reads;
details and exports retain full messages/checkpoints/events where applicable.

A managed subscription owns its socket and buffered queue. Terminal events,
errors, consumer exit and explicit `closeEvents` release observation resources.
Only `interrupt` sends cancellation to the runtime. Closing a browser or ending
a consumer must not silently cancel the Agent.

## Quality Gates

CI independently runs lint, typecheck, build, Vitest, workspace Node tests,
Go Host/storage/activity tests, Python workflow tests and contract-link checks.
Failures are not converted into successful exit codes. A failing pre-existing
check remains visible; the workflow is not evidence that the branch is green
until those jobs actually pass. Test fixtures must isolate both Hermes home
and collaboration database paths.