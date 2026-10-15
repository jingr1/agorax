package agentsessionstore

import (
	"context"
	"reflect"
	"sync"
	"testing"
	"time"
)

// Regression test for a pre-existing race: sync-state saves used to run after
// entry.mu was released, so HideAgentSession could delete the persisted state
// and then a stale save would resurrect it. Saves now hold entry.mu, which
// serializes them with the hide path's delete.
func TestSyncStatePersistenceSerializesWithHide(t *testing.T) {
	store := newBlockingSyncStateStore()
	client := newFakeSyncerRepository()
	client.snapshots["room-1"] = &WorkspaceAgentSnapshot{}
	svc := New(client, WithSyncStateStore(store))
	svc.TrackRoom("room-1")

	markDone := make(chan struct{})
	go func() {
		defer close(markDone)
		svc.MarkActivitySyncPending("room-1", "session-1", 0, 1, 0)
	}()
	<-store.saveEntered

	hideDone := make(chan struct{})
	go func() {
		defer close(hideDone)
		svc.HideAgentSession("room-1", "session-1")
	}()

	select {
	case <-hideDone:
		t.Fatal("HideAgentSession completed while a sync-state save was still in flight")
	case <-time.After(50 * time.Millisecond):
	}

	close(store.saveGate)
	<-markDone
	<-hideDone

	if got := store.operations(); !reflect.DeepEqual(got, []string{"save", "delete"}) {
		t.Fatalf("store operations = %#v, want [save delete]", got)
	}
	if _, resurrected := store.session("session-1"); resurrected {
		t.Fatal("hidden session sync state was resurrected by a stale save")
	}
}

type blockingSyncStateStore struct {
	mu          sync.Mutex
	ops         []string
	sessions    map[string]WorkspaceAgentSyncState
	saveGate    chan struct{}
	saveEntered chan struct{}
	enteredOnce sync.Once
}

func newBlockingSyncStateStore() *blockingSyncStateStore {
	return &blockingSyncStateStore{
		sessions:    make(map[string]WorkspaceAgentSyncState),
		saveGate:    make(chan struct{}),
		saveEntered: make(chan struct{}),
	}
}

func (*blockingSyncStateStore) LoadRoomSyncStates(_ context.Context, _ string) (map[string]WorkspaceAgentSyncState, error) {
	return nil, nil
}

func (s *blockingSyncStateStore) SaveAgentSyncState(_ context.Context, _ string, state WorkspaceAgentSyncState) error {
	s.enteredOnce.Do(func() { close(s.saveEntered) })
	<-s.saveGate
	s.mu.Lock()
	defer s.mu.Unlock()
	s.ops = append(s.ops, "save")
	s.sessions[state.AgentSessionID] = state
	return nil
}

func (s *blockingSyncStateStore) DeleteAgentSyncState(_ context.Context, _ string, agentSessionID string) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.ops = append(s.ops, "delete")
	delete(s.sessions, agentSessionID)
	return nil
}

func (s *blockingSyncStateStore) operations() []string {
	s.mu.Lock()
	defer s.mu.Unlock()
	return append([]string(nil), s.ops...)
}

func (s *blockingSyncStateStore) session(agentSessionID string) (WorkspaceAgentSyncState, bool) {
	s.mu.Lock()
	defer s.mu.Unlock()
	state, ok := s.sessions[agentSessionID]
	return state, ok
}
