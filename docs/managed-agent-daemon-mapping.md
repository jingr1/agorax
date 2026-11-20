# Managed Agent Daemon Mapping

## Control and Execution

| Surface | Owner | Interface |
| --- | --- | --- |
| Agent registry id | Workspace registry | `/api/agents` |
| Display-session to canonical-session/run binding | Workspace bridge run store | Managed bridge / engine APIs |
| Canonical Session / Turn / Interaction | Go Host | Daemon Session, input, cancel and interaction endpoints |
| Provider process and protocol | Daemon runtime provider adapter | Local CLI / ACP transport |
| Activity conversion | Daemon reporter and Node Activity adapter | Activity WS and snapshots |
| Client message projection | Activity Core Session Engine | Typed command port and reconcile port |
| Mission Assignment / review / human gate | Workspace product orchestration | Mission services and MCP; not fake child Sessions |

The executable composition is
[agorax-agentd](../agorax-agent-daemon/packages/agent/daemon/cmd/agorax-agentd/main.go).
It constructs the canonical SQLite store, Agent Host, runtime controller and
durable activity reporter. Claude Code uses the daemon CLI adapter; it is not
a Workspace-owned fallback process or an Anthropic SDK sidecar.

## Coverage

| Product path | Activity/Engine contract | Execution semantics |
| --- | --- | --- |
| Managed 1:1 | Canonical Session/Turn activity and Engine projection | Daemon input/cancel, history and interaction APIs |
| Hermes 1:1 | Hermes SSE translated to Activity and Engine projection | Native Gateway and stable identity mapping |
| Managed group member | Canonical runtime activity, projected into room speech/cards | Room runner remains the group scheduling owner |
| Hermes group member | Room turn/context and Gateway transcript observation | Native group execution; not a managed child Session |
| Hermes Swarm | Assignment/checkpoint projection | tmux/wrapper; workflow gates stay outside Host interactions |

Both tracks share message identity and terminal projection contracts. Their
process lifetimes, cancellation mechanisms and group/workflow scheduling are
not interchangeable. See [architecture](architecture.md) and
[Native Bridge](hermes-native-bridge.md).

## Recovery and Detach

Reconcile managed state from daemon canonical activity, not from socket liveness.
Subscriptions release sockets and queues on terminal/error/consumer exit.
`closeEvents` detaches observation only; `interrupt` requests Turn cancellation.
Preserved dispatch and room leases prevent a Workspace restart from treating an
unknown running execution as new work. Expiry is a reconciliation signal, not
permission to replay a prompt.