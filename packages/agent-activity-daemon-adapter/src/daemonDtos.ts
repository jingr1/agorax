// DTO types mirroring the Agorax agent daemon (`agorax-agent-daemon`) REST
// wire format. This package does not ship a generated HTTP client; these
// hand-maintained types are the structural contract.
//
// Truth sources (Go):
// - REST handlers + response literals:
//   packages/agent/daemon/cmd/agorax-agentd/main.go (every writeJSON payload
//   and every decoded request body struct)
// - Canonical entities: packages/agent/store-sqlite/repository.go
//   (Session, Turn, Interaction, Message, CapabilityReference)
// - Session metadata: packages/agent/store-sqlite/session_metadata.go
//   (SessionMetadata / SessionUsage / SessionGoal)
// - Host results: packages/agent/host/types.go (CreateSessionResult,
//   SendInputResult, CancelTurnResult, SubmitInteractiveResult,
//   ProviderRuntimeSession, TurnLifecycle, SubmitAvailability)
//
// The daemon serializes Go structs with encoding/json. Fields without json
// tags marshal under their PascalCase Go field name; fields with tags are
// annotated below. Go zero values are always emitted: "" for strings, 0 for
// integers, null for nil maps/slices/pointers.

/** storesqlites.CapabilityReference — the one entity with explicit tags. */
export interface DaemonCapabilityReference {
  capability: string;
  source: string;
}

/** storesqlites.CapabilitySnapshot (`{"values": [...]}`). */
export interface DaemonCapabilitySnapshot {
  values: string[];
}

export interface DaemonSessionUsageContextWindow {
  usedTokens: number;
  totalTokens: number;
}

export interface DaemonSessionUsageQuota {
  quotaType: string;
  percentRemaining: number;
  resetsAtUnixMs: number | null;
}

export interface DaemonSessionUsage {
  contextWindow: DaemonSessionUsageContextWindow | null;
  quotas: DaemonSessionUsageQuota[];
}

export interface DaemonSessionGoal {
  objective: string;
  status: string;
  reason?: string;
  startedAtUnixMs?: number;
  iterations?: number;
  durationMs?: number;
  tokens?: number;
}

/** storesqlites.SessionMetadata — embedded in Session as `Metadata`. */
export interface DaemonSessionMetadata {
  visible: boolean;
  imported: boolean;
  usage?: DaemonSessionUsage;
  goal?: DaemonSessionGoal;
}

/**
 * storesqlites.Session — the daemon's canonical Session projection, emitted
 * verbatim as the `session` key of GET .../activity. Field names are the
 * PascalCase Go field names (e.g. `ID`, `ActiveTurnID`, `CreatedAtUnixMS`).
 */
export interface DaemonCanonicalSession {
  ID: string;
  WorkspaceID: string;
  /** "root" | "child" (storesqlites.SessionKindRoot/Child). */
  Kind: string;
  RootAgentSessionID: string;
  RootTurnID: string;
  ParentAgentSessionID: string;
  ParentTurnID: string;
  ParentToolCallID: string;
  Origin: string;
  UserID: string;
  AgentTargetID: string;
  Provider: string;
  ProviderSessionID: string;
  Model: string;
  Settings: Record<string, unknown> | null;
  Capabilities: DaemonCapabilitySnapshot | null;
  Metadata: DaemonSessionMetadata;
  InternalRuntimeContext: Record<string, unknown> | null;
  Cwd: string;
  RailSectionKind: string;
  RailProjectPath: string;
  RailSectionKey: string;
  Title: string;
  ActiveTurnID: string;
  MessageVersion: number;
  LastEventUnixMS: number;
  StartedAtUnixMS: number;
  EndedAtUnixMS: number;
  PinnedAtUnixMS: number;
  CreatedAtUnixMS: number;
  UpdatedAtUnixMS: number;
}

/**
 * storesqlites.Turn — emitted as items of the `turns` array of
 * GET .../activity. Unlike the daemon generated DTO, the error is carried as
 * flat `ErrorMessage`/`ErrorCode` strings and completed commands as
 * `CompletedCommandKind`/`CompletedCommandStatus`.
 */
export interface DaemonCanonicalTurn {
  WorkspaceID: string;
  AgentSessionID: string;
  TurnID: string;
  IdentityAnchorTurnID: string;
  /** daemon field: items are lowercase-tagged CapabilityReference. */
  CapabilityRefs: DaemonCapabilityReference[] | null;
  Phase: string;
  Outcome: string;
  ErrorMessage: string;
  ErrorCode: string;
  FileChanges: Record<string, unknown> | null;
  CompletedCommandKind: string;
  CompletedCommandStatus: string;
  FinalAssistantMessageID: string;
  FinalAssistantMessageResolved: boolean;
  Backfilled: boolean;
  StartedAtUnixMS: number;
  SettledAtUnixMS: number;
  CreatedAtUnixMS: number;
  UpdatedAtUnixMS: number;
  Origin: string;
  SourceGoalOperationID: string;
  SourceGoalRevision: number;
  SourceGoalRepairEpoch: number;
  RootProviderTurnID: string;
  /** json.RawMessage — untyped provider binding payload. */
  ProviderTurnBindingJSON: unknown;
  ProviderForkBindingAvailable: boolean;
  RootProviderTurnPhase: string;
  RootProviderTurnOutcome: string;
  RootProviderTurnErrorMessage: string;
  RootProviderTurnErrorCode: string;
  RootProviderTurnCompletedCommandKind: string;
  RootProviderTurnCompletedCommandStatus: string;
  RootProviderTurnUpdatedAtUnixMS: number;
}

/**
 * storesqlites.MessageSemantics — explicit camelCase tags on the Go struct;
 * embedded in Message as `Semantics`.
 */
export interface DaemonMessageSemantics {
  userVisibleAssistantResponse: boolean;
  turnSettling?: boolean;
  noticeCommand?: string;
  noticeCommandStatus?: string;
}

/**
 * storesqlites.Message — emitted as items of the `messages` array of
 * GET .../activity. `ID` is the per-session row sequence; `Version` is the
 * per-session change cursor.
 */
export interface DaemonCanonicalMessage {
  ID: number;
  AgentSessionID: string;
  MessageID: string;
  Version: number;
  TurnID: string;
  Role: string;
  Kind: string;
  Status: string;
  Semantics: DaemonMessageSemantics | null;
  Payload: Record<string, unknown> | null;
  OccurredAtUnixMS: number;
  StartedAtUnixMS: number;
  CompletedAtUnixMS: number;
  CreatedAtUnixMS: number;
  UpdatedAtUnixMS: number;
}

/**
 * storesqlites.Interaction — emitted as items of the `interactions` array of
 * GET .../activity and GET .../interactions.
 */
export interface DaemonCanonicalInteraction {
  WorkspaceID: string;
  AgentSessionID: string;
  RequestID: string;
  TurnID: string;
  /** "approval" | "question" | "plan". */
  Kind: string;
  /** "pending" | "answered" | "superseded". */
  Status: string;
  ToolName: string;
  Input: Record<string, unknown> | null;
  Output: Record<string, unknown> | null;
  Metadata: Record<string, unknown> | null;
  CreatedAtUnixMS: number;
  UpdatedAtUnixMS: number;
}

/** Response of GET /v1/workspaces/{id}/agent-sessions/{id}/activity (main.go). */
export interface DaemonSessionActivityResponse {
  workspaceId: string;
  session: DaemonCanonicalSession;
  turns: DaemonCanonicalTurn[];
  messages: DaemonCanonicalMessage[];
  interactions: DaemonCanonicalInteraction[];
  /**
   * Message high-water cursor of the returned page (== page LatestVersion).
   * Added by the paged activity read; absent on pre-paging daemon builds.
   */
  messageVersion?: number;
  /** Whether more messages exist after `messageVersion`. */
  hasMoreMessages?: boolean;
}

/** Response of GET /v1/workspaces/{id}/agent-sessions (main.go). */
export interface DaemonAgentSessionsListResponse {
  workspaceId: string;
  /** Emitted as `[]` (never null) when the workspace has no sessions. */
  sessions: DaemonCanonicalSession[];
}

/** Response of GET /v1/workspaces/{id}/agent-sessions/{id}/interactions. */
export interface DaemonSessionInteractionsResponse {
  workspaceId: string;
  agentSessionId: string;
  interactions: DaemonCanonicalInteraction[];
}

/** agenthost.CompletedCommand — nested pointer, PascalCase keys. */
export interface DaemonCompletedCommand {
  Kind: string;
  Status: string;
}

/** agenthost.TurnLifecycle — nested struct in runtime results. */
export interface DaemonTurnLifecycle {
  ActiveTurnID: string | null;
  Phase: string;
  Settling: boolean;
  Outcome: string | null;
  CompletedCommand: DaemonCompletedCommand | null;
}

/** agenthost.SubmitAvailability — nested struct in runtime results. */
export interface DaemonSubmitAvailability {
  State: string;
  Reason: string;
}

/**
 * agenthost.ProviderRuntimeSession — the runtime observation embedded in
 * create/send results.
 */
export interface DaemonProviderRuntimeSession {
  ID: string;
  WorkspaceID: string;
  Scope: string;
  SourceAgentSessionID: string;
  SideRequestID: string;
  UserID: string;
  AgentTargetID: string;
  Provider: string;
  ProviderSessionID: string;
  Resumable: boolean;
  Cwd: string;
  Env: string[] | null;
  MCPServers: unknown[] | null;
  ProviderTargetRef: Record<string, unknown> | null;
  Settings: Record<string, unknown> | null;
  Capabilities: DaemonCapabilitySnapshot | null;
  RuntimeContext: Record<string, unknown> | null;
  Status: string;
  TurnLifecycle: DaemonTurnLifecycle | null;
  SubmitAvailability: DaemonSubmitAvailability | null;
  Visible: boolean;
  Title: string;
  InitialTitleEstablished: boolean;
  Provisional: boolean;
  LastError: string;
  PinnedAtUnixMS: number;
  CreatedAtUnixMS: number;
  UpdatedAtUnixMS: number;
}

/**
 * storesqlites.RuntimeOperation — carried as `Operation` in cancel and
 * interaction-response results. Only the identity/lifecycle fields are typed
 * here; `Payload` keeps provider-specific extensions.
 */
export interface DaemonRuntimeOperation {
  OperationID: string;
  WorkspaceID: string;
  AgentSessionID: string;
  Kind: string;
  Status: string;
  Result: string;
  TurnID: string;
  RequestID: string;
  Payload: Record<string, unknown> | null;
}

/** agenthost.CreateSessionResult — POST .../agent-sessions response body. */
export interface DaemonCreateSessionResponse {
  Session: DaemonProviderRuntimeSession;
  Canonical: DaemonCanonicalSession;
  TurnID: string;
  Kind: string;
  // TODO(daemon-endpoint): GoalControl is typed struct GoalControlResult in
  // the daemon but never populated by the REST handler (no goal route); the
  // daemon runs with goal endpoints disabled at the REST surface.
  GoalControl: unknown | null;
  SessionStatus: string;
  InitialGoalStatus: string;
}

/** agenthost.SendInputResult — POST .../input response body. */
export interface DaemonSendInputResponse {
  Session: DaemonProviderRuntimeSession;
  Canonical: DaemonCanonicalSession;
  Turn: DaemonCanonicalTurn | null;
  TurnID: string;
  TurnLifecycle: DaemonTurnLifecycle;
  SubmitAvailability: DaemonSubmitAvailability;
  Kind: string;
  GoalControl: unknown | null;
}

/** agenthost.CancelTurnResult — POST .../turns/{id}/cancel response body. */
export interface DaemonCancelTurnResponse {
  Canonical: DaemonCanonicalSession;
  Turn: DaemonCanonicalTurn | null;
  Operation: DaemonRuntimeOperation;
  State: string;
  IntentAccepted: boolean;
  ProviderConfirmed: boolean;
  Settled: boolean;
  Outcome: string;
}

/** agenthost.SubmitInteractiveResult — interaction response body. */
export interface DaemonSubmitInteractiveResponse {
  Canonical: DaemonCanonicalSession;
  Operation: DaemonRuntimeOperation;
  Disposition: string;
}

/** Response of GET /v1/agent-targets. */
export interface DaemonAgentTargetsResponse {
  agents: { id: string; enabled: boolean }[];
  runtimeReady: boolean;
}

/**
 * WebSocket frame from GET /v1/events/ws: `{"kind":"event","event":{...}}`
 * (agorax-agentd/events.go). `event` is the full activity envelope:
 * a random `id`, the shared monotonic `version` (per-daemon revision,
 * assigned under one lock so frames are emitted in version order),
 * `emittedAt` unix-ms, `scope.workspaceId`, and `payload` carrying
 * `workspaceId`/`agentSessionId`/`eventType` plus the per-event `data`
 * (`turn`, `interaction`, message content, ...) untyped.
 */
export interface DaemonActivityEventFrame {
  kind: "event";
  event: {
    id: string;
    topic: string;
    version: number;
    emittedAt: number;
    scope: { workspaceId: string };
    payload: {
      workspaceId: string;
      agentSessionId: string;
      eventType:
        | "message_delta"
        | "message_update"
        | "turn_update"
        | "interaction_update"
        | "session_reconcile_required"
        | "session_deleted"
        | string;
      data: Record<string, unknown>;
    };
  };
}

// --- Request bodies (decode structs in agorax-agentd/main.go) ---

/**
 * agenthost.PromptContentBlock — the daemon prompt block wire shape
 * (camelCase json tags with omitempty).
 */
export interface DaemonPromptContentBlock {
  type: string;
  text?: string;
  mimeType?: string;
  data?: string;
  url?: string;
  attachmentId?: string;
  name?: string;
  path?: string;
  connectorKey?: string;
}

/**
 * POST .../agent-sessions request body. Field names mirror the anonymous
 * decode struct in agorax-agentd/main.go. `content`/`initialContent` accept
 * either a plain string or a block array (daemon promptText).
 */
export interface DaemonCreateAgentSessionRequest {
  agentSessionId: string;
  agentTargetId: string;
  provider?: string;
  clientSubmitId: string;
  content?: string | DaemonPromptContentBlock[];
  initialContent?: string | DaemonPromptContentBlock[];
  /** UI-only text when initialContent carries injected skills / bundles. */
  displayPrompt?: string;
  cwd?: string;
  model?: string;
  reasoningEffort?: string;
  /** Agorax Mission MCP control channel (per-run handshake). */
  mcpEndpoint?: string;
  mcpRunToken?: string;
  mcpToolAllowlist?: string[];
}

/** POST .../input request body (decode struct: clientSubmitId, content, displayPrompt). */
export interface DaemonSendAgentSessionInputRequest {
  clientSubmitId: string;
  content: string | DaemonPromptContentBlock[];
  /** UI-only text when content carries injected skills / bundles. */
  displayPrompt?: string;
}

/** POST .../interactions/{requestId}/response request body. */
export interface DaemonSubmitInteractionResponseRequest {
  action?: string;
  optionId?: string;
  payload?: Record<string, unknown>;
}

// --- Composer contracts without a daemon endpoint yet ---

/**
 * Daemon composer-options REST response (session or provider scoped).
 * Shape mirrors the generated daemon `AgentProviderComposerOptionsResponse`
 * contract consumed by `agentActivityComposerOptionsFromDaemonResult`.
 */
export interface DaemonProviderComposerOptionsResponse {
  provider?: string;
  codexSaverModeSupported?: boolean;
  rtkSaverModeSupported?: boolean;
  capabilities?: Record<string, unknown>;
  modelConfig?: {
    configurable?: boolean;
    effectiveValue?: string;
    currentValue?: string;
    defaultValue?: string;
    options?: unknown[];
  };
  reasoningConfig?: {
    configurable?: boolean;
    effectiveValue?: string;
    currentValue?: string;
    defaultValue?: string;
    options?: unknown[];
  };
  speedConfig?: {
    configurable?: boolean;
    effectiveValue?: string;
    currentValue?: string;
    defaultValue?: string;
    options?: unknown[];
  };
  reasoningOptionsByModel?: Record<string, unknown>;
  effectiveSettings?: Record<string, unknown>;
  permissionConfig?: {
    configurable?: boolean;
    defaultValue?: string;
    currentValue?: string;
    modes?: unknown[];
  };
  runtimeContext?: Record<string, unknown>;
  skills?: unknown[];
  commands?: unknown[];
  capabilityCatalog?: unknown[];
  behavior?: Record<string, unknown>;
  slashCommandPolicy?: {
    fallbackCommands?: unknown[];
    commandEffects?: unknown[];
    commandCatalogAuthoritative?: boolean;
  };
}

/**
 * TODO(daemon-endpoint): no daemon composer-settings route exists. Kept so
 * hosts can keep calling the reverse projection; mirrors the generated
 * daemon `AgentSessionComposerSettings` contract (camelCase keys).
 */
export interface DaemonAgentSessionComposerSettings {
  model?: string | null;
  permissionModeId?: string | null;
  planMode?: boolean | null;
  browserUse?: boolean | null;
  reasoningEffort?: string | null;
  speed?: string | null;
}
