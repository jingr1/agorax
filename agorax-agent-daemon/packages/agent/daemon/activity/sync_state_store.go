package agentsessionstore

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"sync"
)

// FileAgentSyncStateStore is a file-backed SyncStateStore and
// MessageCursorStore. Each room is stored as one JSON document under the root
// directory (file name derived from the roomID scope identifier: agorax side =
// workspace ID, external daemons (tsh) = control-plane room ID; workspace ≡
// room, one-to-one), tracking per-session sync status, pending report counts,
// failure counters, last error, and message sync cursors. Writes are atomic
// (temp file + rename) and guarded by a process-wide mutex, so a single store
// instance is safe for concurrent use.
type FileAgentSyncStateStore struct {
	root string
	mu   sync.Mutex
}

var (
	_ SyncStateStore     = (*FileAgentSyncStateStore)(nil)
	_ MessageCursorStore = (*FileAgentSyncStateStore)(nil)
)

// NewFileAgentSyncStateStore returns a FileAgentSyncStateStore rooted at the
// given directory. The directory is created lazily on first write.
func NewFileAgentSyncStateStore(root string) *FileAgentSyncStateStore {
	return &FileAgentSyncStateStore{root: strings.TrimSpace(root)}
}

func (s *FileAgentSyncStateStore) LoadRoomSyncStates(_ context.Context, roomID string) (map[string]WorkspaceAgentSyncState, error) {
	path, err := s.roomPath(roomID)
	if err != nil {
		return nil, err
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	raw, err := os.ReadFile(path)
	if err != nil {
		if os.IsNotExist(err) {
			return nil, nil
		}
		return nil, err
	}
	var doc fileAgentSyncStateDocument
	if err := json.Unmarshal(raw, &doc); err != nil {
		return nil, err
	}
	out := make(map[string]WorkspaceAgentSyncState, len(doc.Sessions))
	for agentSessionID, syncState := range doc.Sessions {
		agentSessionID = strings.TrimSpace(agentSessionID)
		if agentSessionID == "" {
			continue
		}
		if strings.TrimSpace(syncState.AgentSessionID) == "" {
			syncState.AgentSessionID = agentSessionID
		}
		out[agentSessionID] = syncState
	}
	return out, nil
}

func (s *FileAgentSyncStateStore) SaveAgentSyncState(_ context.Context, roomID string, syncState WorkspaceAgentSyncState) error {
	agentSessionID := strings.TrimSpace(syncState.AgentSessionID)
	if agentSessionID == "" {
		return nil
	}
	return s.updateRoom(roomID, func(doc *fileAgentSyncStateDocument) {
		if doc.Sessions == nil {
			doc.Sessions = make(map[string]WorkspaceAgentSyncState)
		}
		syncState.AgentSessionID = agentSessionID
		doc.Sessions[agentSessionID] = syncState
	})
}

func (s *FileAgentSyncStateStore) DeleteAgentSyncState(_ context.Context, roomID string, agentSessionID string) error {
	agentSessionID = strings.TrimSpace(agentSessionID)
	if agentSessionID == "" {
		return nil
	}
	return s.updateRoom(roomID, func(doc *fileAgentSyncStateDocument) {
		delete(doc.Sessions, agentSessionID)
	})
}

func (s *FileAgentSyncStateStore) LoadRoomMessageCursors(_ context.Context, roomID string) (map[string]uint64, error) {
	path, err := s.roomPath(roomID)
	if err != nil {
		return nil, err
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	raw, err := os.ReadFile(path)
	if err != nil {
		if os.IsNotExist(err) {
			return nil, nil
		}
		return nil, err
	}
	var doc fileAgentSyncStateDocument
	if err := json.Unmarshal(raw, &doc); err != nil {
		return nil, err
	}
	out := make(map[string]uint64, len(doc.Cursors))
	for agentSessionID, cursor := range doc.Cursors {
		agentSessionID = strings.TrimSpace(agentSessionID)
		if agentSessionID == "" || cursor == 0 {
			continue
		}
		out[agentSessionID] = cursor
	}
	return out, nil
}

func (s *FileAgentSyncStateStore) SaveMessageCursor(_ context.Context, roomID string, agentSessionID string, version uint64) error {
	agentSessionID = strings.TrimSpace(agentSessionID)
	if agentSessionID == "" {
		return nil
	}
	return s.updateRoom(roomID, func(doc *fileAgentSyncStateDocument) {
		if doc.Cursors == nil {
			doc.Cursors = make(map[string]uint64)
		}
		doc.Cursors[agentSessionID] = version
	})
}

func (s *FileAgentSyncStateStore) DeleteMessageCursor(_ context.Context, roomID string, agentSessionID string) error {
	agentSessionID = strings.TrimSpace(agentSessionID)
	if agentSessionID == "" {
		return nil
	}
	return s.updateRoom(roomID, func(doc *fileAgentSyncStateDocument) {
		delete(doc.Cursors, agentSessionID)
	})
}

type fileAgentSyncStateDocument struct {
	Sessions map[string]WorkspaceAgentSyncState `json:"sessions"`
	Cursors  map[string]uint64                  `json:"cursors,omitempty"`
}

func (s *FileAgentSyncStateStore) updateRoom(roomID string, update func(*fileAgentSyncStateDocument)) error {
	path, err := s.roomPath(roomID)
	if err != nil {
		return err
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	doc := fileAgentSyncStateDocument{Sessions: map[string]WorkspaceAgentSyncState{}}
	raw, err := os.ReadFile(path)
	if err != nil && !os.IsNotExist(err) {
		return err
	}
	if len(raw) > 0 {
		if err := json.Unmarshal(raw, &doc); err != nil {
			return err
		}
		if doc.Sessions == nil {
			doc.Sessions = make(map[string]WorkspaceAgentSyncState)
		}
	}
	if update != nil {
		update(&doc)
	}
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		return err
	}
	raw, err = json.MarshalIndent(doc, "", "  ")
	if err != nil {
		return err
	}
	tmpPath := path + ".tmp"
	if err := os.WriteFile(tmpPath, raw, 0o644); err != nil {
		return err
	}
	return os.Rename(tmpPath, path)
}

func (s *FileAgentSyncStateStore) roomPath(roomID string) (string, error) {
	root := strings.TrimSpace(s.root)
	roomID = strings.TrimSpace(roomID)
	if root == "" {
		return "", fmt.Errorf("agent sync state store root is required")
	}
	if roomID == "" {
		return "", fmt.Errorf("room id is required")
	}
	return filepath.Join(root, base64.RawURLEncoding.EncodeToString([]byte(roomID))+".json"), nil
}
