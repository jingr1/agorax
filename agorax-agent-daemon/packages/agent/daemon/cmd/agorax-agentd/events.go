package main

import (
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"log/slog"
	"strings"
	"sync"
	"time"
)

// Agorax agent activity contract topic and event types
// (packages/events/protocol/definitions/agent/activity.updated.event.json).
const (
	agentActivityUpdatedTopic = "agent.activity.updated"

	activityEventTurnUpdate               = "turn_update"
	activityEventMessageUpdate            = "message_update"
	activityEventMessageDelta             = "message_delta"
	activityEventInteractionUpdate        = "interaction_update"
	activityEventSessionReconcileRequired = "session_reconcile_required"
)

type eventHub struct {
	mu   sync.Mutex
	subs map[chan []byte]struct{}

	// revision is the monotonic envelope revision shared by every frame. It
	// is a per-daemon sequence, not the protocol schema version.
	revision uint64
}

func newEventHub() *eventHub { return &eventHub{subs: make(map[chan []byte]struct{})} }

func (h *eventHub) subscribe() (chan []byte, func()) {
	channel := make(chan []byte, 32)
	h.mu.Lock()
	h.subs[channel] = struct{}{}
	h.mu.Unlock()
	return channel, func() {
		h.mu.Lock()
		delete(h.subs, channel)
		close(channel)
		h.mu.Unlock()
	}
}

func (h *eventHub) publish(value any) {
	payload, err := json.Marshal(map[string]any{"kind": "event", "event": value})
	if err != nil {
		return
	}
	h.mu.Lock()
	defer h.mu.Unlock()
	h.broadcastLocked(payload)
}

func (h *eventHub) broadcastLocked(payload []byte) {
	for channel := range h.subs {
		select {
		case channel <- payload:
		default:
			// A lagging subscriber misses this frame; its client must
			// reconnect and reconcile from canonical reads (events are hints).
			slog.Warn("agent activity event dropped for lagging subscriber",
				"event", "agent_activity.subscription.frame_dropped",
				"frame_bytes", len(payload),
			)
		}
	}
}

// publishActivity emits one agent.activity.updated frame in the Agorax
// envelope shape: {id, topic, version, emittedAt, scope:{workspaceId},
// payload:{workspaceId, agentSessionId, eventType, data}}. Identity fields
// are injected into data when absent so clients can run envelope consistency
// checks against payload and data.
func (h *eventHub) publishActivity(workspaceID, agentSessionID, eventType string, data map[string]any) {
	if h == nil {
		return
	}
	workspaceID = strings.TrimSpace(workspaceID)
	agentSessionID = strings.TrimSpace(agentSessionID)
	eventType = strings.TrimSpace(eventType)
	if workspaceID == "" || agentSessionID == "" || eventType == "" {
		return
	}
	if data == nil {
		data = map[string]any{}
	}
	if _, ok := data["workspaceId"]; !ok {
		data["workspaceId"] = workspaceID
	}
	if _, ok := data["agentSessionId"]; !ok {
		data["agentSessionId"] = agentSessionID
	}
	if _, ok := data["eventType"]; !ok {
		data["eventType"] = eventType
	}
	// Assign the monotonic revision and fan out under one lock so subscribers
	// observe envelope versions in emission order.
	h.mu.Lock()
	defer h.mu.Unlock()
	h.revision++
	envelope := map[string]any{
		"id":        newEventID(),
		"topic":     agentActivityUpdatedTopic,
		"version":   h.revision,
		"emittedAt": time.Now().UnixMilli(),
		"scope":     map[string]any{"workspaceId": workspaceID},
		"payload": map[string]any{
			"workspaceId":    workspaceID,
			"agentSessionId": agentSessionID,
			"eventType":      eventType,
			"data":           data,
		},
	}
	payload, err := json.Marshal(map[string]any{"kind": "event", "event": envelope})
	if err != nil {
		return
	}
	h.broadcastLocked(payload)
}

// publishActivityJSON preserves an already-encoded data payload byte-for-byte
// (live protocol message deltas) instead of round-tripping it through
// map[string]any.
func (h *eventHub) publishActivityJSON(workspaceID, agentSessionID, eventType string, data json.RawMessage) {
	if h == nil || len(data) == 0 {
		return
	}
	var decoded map[string]any
	if err := json.Unmarshal(data, &decoded); err != nil {
		return
	}
	h.publishActivity(workspaceID, agentSessionID, eventType, decoded)
}

// publishSessionReconcileRequired emits the recoverable-loss signal: the
// client must re-read canonical activity because events may have been missed.
func (h *eventHub) publishSessionReconcileRequired(workspaceID, agentSessionID string, lastEventUnixMS int64) {
	if lastEventUnixMS <= 0 {
		lastEventUnixMS = time.Now().UnixMilli()
	}
	h.publishActivity(workspaceID, agentSessionID, activityEventSessionReconcileRequired, map[string]any{
		"lastEventUnixMs": lastEventUnixMS,
	})
}

// newEventID returns a random 128-bit event id (8-4-4-4-12 hex, no external
// UUID dependency).
func newEventID() string {
	var bytes [16]byte
	if _, err := rand.Read(bytes[:]); err != nil {
		// crypto/rand failure on Linux is unrecoverable in practice; fall back
		// to a time-derived value so envelope shape stays valid.
		nanos := time.Now().UnixNano()
		for index := range bytes {
			bytes[index] = byte(nanos >> (index % 8 * 8))
		}
	}
	encoded := hex.EncodeToString(bytes[:])
	return encoded[0:8] + "-" + encoded[8:12] + "-" + encoded[12:16] + "-" + encoded[16:20] + "-" + encoded[20:32]
}
