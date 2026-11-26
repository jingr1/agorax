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

### Provider turn complete（统一对齐 Tutti）

Settle 必须以**协议侧 turn complete** 为准，不得绑进程寿命（除非协议从未给出
完成信号）。

| Runtime | Adapter | Settle 信号（Tutti 同源） | 进程 EOF？ |
| --- | --- | --- | --- |
| Claude Code | Claude CLI (`stream-json`) | stdout `result` 行 | 仅无 `result` 时 fallback |
| Codex | App Server | `turn/completed` 通知 | 否（长驻 app-server） |
| Cursor / OpenCode / Kimi / Nexight / OpenClaw / generic ACP | Standard ACP（及 strategy 变体） | `session/prompt` RPC 返回 + `stopReason` | 否（会话级长驻进程） |

Claude CLI 曾在进程 EOF 后才 settle；已改为 `result` 即时 settle。

### UI chrome vs Host settle（Managed 通病）

Managed 各 runtime 都可能在**最后可见 delta / 消息 completed 之后**仍把 Host
turn 留在 `running`（协议收尾、prompt RPC、进程清理）。这不是再提前 settle
能消掉的。

| 信号 | 跟谁走 | 用途 |
| --- | --- | --- |
| `turnBusy` | Host turn `phase !== settled`（或 submitting） | 队列门 / 勿把新 user 写进 list |
| `isStreaming` / `streamingMessageId` / Stop（composer `isLoading`） | Activity 仍有非终态 assistant/tool | 正文 caret、Stop；内容完成后立即清掉 |

禁止在 Host turn 仍 open 时把已 `complete` 的 assistant 强行刷回
`__streamingStatus: streaming`。

Claude CLI：组装后的 `assistant` 行（通常早于 `result`）会
`assistant_segment_complete` → normalizer `Finish(completed)`，只关正文段、
不 settle Host turn。ACP tool_call 路径本来就会在 tool 前 `Finish` 正文段。
改 daemon 后需重建 `agorax-agentd` 才生效。本地 start / `ensureManagedAgentDaemon`
在 `:8788` 已健康时，若 `$ROOT/.agorax/agorax-agentd` 比监听进程更新（或路径不是本仓库二进制），会自动替换旧进程，避免装了新版本仍跑旧 daemon。

## Coverage

| Product path | Activity/Engine contract | Execution semantics |
| --- | --- | --- |
| Managed 1:1 | Canonical Session/Turn activity and Engine projection | Daemon input/cancel, history and interaction APIs |
| Hermes 1:1 | Hermes SSE → Activity/Engine; display history from daemon `agent.db` via hermes-bridge | Native Gateway execution; daemon Host storage for Agorax-initiated turns |
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