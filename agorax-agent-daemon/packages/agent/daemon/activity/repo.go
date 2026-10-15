package agentsessionstore

import "context"

type Repository interface {
	ReadRepository
	ReportSessionState(ctx context.Context, input ReportSessionStateInput) (ReportSessionStateReply, error)
	ReportSessionMessages(ctx context.Context, input ReportSessionMessagesInput) (ReportSessionMessagesReply, error)
}

type ReadRepository interface {
	ListAgents(ctx context.Context, roomID string) (*WorkspaceAgentSnapshot, error)
	ListSessionMessages(ctx context.Context, input ListSessionMessagesInput) (*ListSessionMessagesReply, error)
}

// SyncStateStore persists per-session activity sync state (pending report
// counts, failure counters, last error) across daemon restarts. It is a public
// extension point: external daemons embedding this package (for example a
// desktop daemon projecting local agent activity to a cloud controlplane) can
// inject their own persistence via WithSyncStateStore. FileAgentSyncStateStore
// is a ready-made file-backed implementation.
//
// All methods are keyed by roomID, an opaque scope identifier: on the agorax
// side it is the workspace ID; for external daemons such as tsh it is the
// control-plane room ID. workspace ≡ room, one-to-one — the same value as the
// WorkspaceID carried by report inputs (sent on the wire as roomId), with no
// implicit translation anywhere. Implementations must be safe for concurrent
// use. When no store is injected the Store keeps sync states in memory only,
// matching historical behavior.
type SyncStateStore interface {
	// LoadRoomSyncStates returns the persisted sync states for a room keyed by
	// agent session id. A nil map with a nil error means nothing is persisted.
	LoadRoomSyncStates(ctx context.Context, roomID string) (map[string]WorkspaceAgentSyncState, error)
	// SaveAgentSyncState upserts the sync state for state.AgentSessionID.
	SaveAgentSyncState(ctx context.Context, roomID string, state WorkspaceAgentSyncState) error
	// DeleteAgentSyncState removes the sync state for the given agent session.
	// Deleting an absent entry must not be an error.
	DeleteAgentSyncState(ctx context.Context, roomID string, agentSessionID string) error
}

// MessageCursorStore persists per-session message sync cursors: the highest
// remote message version the Store has already ingested for a session. With a
// store injected (WithMessageCursorStore) the syncer resumes message pulls
// from the persisted cursor after a daemon restart instead of refetching from
// version zero. Without one, cursors live in memory only (historical
// behavior).
//
// Like SyncStateStore, all methods are keyed by roomID, an opaque scope
// identifier: agorax side = workspace ID, external daemons (tsh) = control-plane
// room ID; workspace ≡ room, one-to-one, no implicit translation.
// Implementations must be safe for concurrent use, and deleting an absent
// cursor must not be an error. FileAgentSyncStateStore implements this
// interface alongside SyncStateStore.
type MessageCursorStore interface {
	// LoadRoomMessageCursors returns the persisted cursors for a room keyed by
	// agent session id. A nil map with a nil error means nothing is persisted.
	LoadRoomMessageCursors(ctx context.Context, roomID string) (map[string]uint64, error)
	// SaveMessageCursor upserts the cursor for the given agent session.
	SaveMessageCursor(ctx context.Context, roomID string, agentSessionID string, version uint64) error
	// DeleteMessageCursor removes the cursor for the given agent session.
	DeleteMessageCursor(ctx context.Context, roomID string, agentSessionID string) error
}
