package main

import (
	"context"
	"errors"
	"fmt"
	"strings"
	"sync"
	"time"

	"agorax.local/agent-daemon/packages/agent/daemon/liveprotocol"
	agentruntime "agorax.local/agent-daemon/packages/agent/daemon/runtime"
)

// agentActivityEventBridge projects the ordered precommit runtime stream into
// the public agent.activity.updated WebSocket, mirroring Agorax's upstream
// agentRuntimeActivityEventBridge: message_delta frames keep their validated
// live-protocol payload byte-for-byte (text, toolOutput, payloadSet and
// payloadUnset operations), while malformed or cross-scoped deltas downgrade
// to a throttled session_reconcile_required hint because durable canonical
// reads remain the reconciliation source of truth.
type agentActivityEventBridge struct {
	hub *eventHub

	reconcileMu            sync.Mutex
	reconcileLastByKey     map[string]time.Time
	reconcileInFlightByKey map[string]struct{}
}

const (
	// Collapse reconcile bursts to one signal per window while a persistent
	// protocol error still gets periodic recovery.
	bridgeReconcileThrottle  = 250 * time.Millisecond
	bridgeReconcileRetention = 5 * time.Minute
	bridgeReconcileStateCap  = 1024
)

var _ agentruntime.RuntimeStreamEventObserver = (*agentActivityEventBridge)(nil)

func (b *agentActivityEventBridge) ObserveRuntimeStreamEvents(
	_ context.Context,
	workspaceID string,
	agentSessionID string,
	events []agentruntime.StreamEvent,
) error {
	if b == nil || b.hub == nil {
		return nil
	}
	var publishErrors []error
	for _, streamEvent := range events {
		switch streamEvent.EventType {
		case agentruntime.StreamEventMessageDelta:
			event, ok := streamEvent.Data.(liveprotocol.Event)
			if !ok {
				publishErrors = append(publishErrors,
					fmt.Errorf("message_delta stream data has type %T", streamEvent.Data))
				b.hub.publishSessionReconcileRequired(workspaceID, agentSessionID, time.Now().UnixMilli())
				continue
			}
			if strings.TrimSpace(event.WorkspaceID) != strings.TrimSpace(workspaceID) ||
				strings.TrimSpace(event.AgentSessionID) != strings.TrimSpace(agentSessionID) {
				publishErrors = append(publishErrors, fmt.Errorf(
					"message_delta stream identity does not match its runtime scope: expected workspace/session %q/%q, got %q/%q",
					strings.TrimSpace(workspaceID), strings.TrimSpace(agentSessionID),
					strings.TrimSpace(event.WorkspaceID), strings.TrimSpace(event.AgentSessionID),
				))
				b.publishReconcileThrottled(workspaceID, agentSessionID)
				continue
			}
			b.hub.publishActivityJSON(event.WorkspaceID, event.AgentSessionID, string(event.EventType), event.Data)
		case agentruntime.StreamEventSessionReconcileRequired:
			// The runtime event hub replaced a lagging subscriber's queue with
			// this signal; forward it so WS clients reconcile as well.
			reason := ""
			if data, ok := streamEvent.Data.(map[string]any); ok {
				reason, _ = data["reason"].(string)
			}
			data := map[string]any{"lastEventUnixMs": time.Now().UnixMilli()}
			if reason != "" {
				data["reason"] = reason
			}
			b.hub.publishActivity(workspaceID, agentSessionID, activityEventSessionReconcileRequired, data)
		default:
			// Turn and message updates are published post-commit by the
			// durable reporters; precommit stream patches stay internal.
		}
	}
	return errors.Join(publishErrors...)
}

// publishReconcileThrottled bounds reconcile signals for a persistent broken
// delta stream to one per throttle window per session.
func (b *agentActivityEventBridge) publishReconcileThrottled(workspaceID, agentSessionID string) {
	key := strings.TrimSpace(workspaceID) + "\x00" + strings.TrimSpace(agentSessionID)
	claimedAt := time.Now()
	if !b.claimReconcile(key, claimedAt) {
		return
	}
	b.hub.publishSessionReconcileRequired(workspaceID, agentSessionID, claimedAt.UnixMilli())
	b.finishReconcile(key, claimedAt)
}

func (b *agentActivityEventBridge) claimReconcile(key string, now time.Time) bool {
	if b == nil || key == "\x00" {
		return false
	}
	b.reconcileMu.Lock()
	defer b.reconcileMu.Unlock()
	if b.reconcileLastByKey == nil {
		b.reconcileLastByKey = make(map[string]time.Time)
	}
	if b.reconcileInFlightByKey == nil {
		b.reconcileInFlightByKey = make(map[string]struct{})
	}
	for staleKey, last := range b.reconcileLastByKey {
		if _, inFlight := b.reconcileInFlightByKey[staleKey]; !inFlight && now.Sub(last) >= bridgeReconcileRetention {
			delete(b.reconcileLastByKey, staleKey)
		}
	}
	if _, inFlight := b.reconcileInFlightByKey[key]; inFlight {
		return false
	}
	if last, ok := b.reconcileLastByKey[key]; ok && now.Sub(last) < bridgeReconcileThrottle {
		return false
	}
	if len(b.reconcileLastByKey) >= bridgeReconcileStateCap {
		var oldestKey string
		var oldest time.Time
		for candidateKey, last := range b.reconcileLastByKey {
			if oldestKey == "" || last.Before(oldest) {
				oldestKey, oldest = candidateKey, last
			}
		}
		if oldestKey != "" {
			delete(b.reconcileLastByKey, oldestKey)
		}
	}
	b.reconcileInFlightByKey[key] = struct{}{}
	return true
}

func (b *agentActivityEventBridge) finishReconcile(key string, claimedAt time.Time) {
	if b == nil {
		return
	}
	b.reconcileMu.Lock()
	defer b.reconcileMu.Unlock()
	delete(b.reconcileInFlightByKey, key)
	if b.reconcileLastByKey == nil {
		b.reconcileLastByKey = make(map[string]time.Time)
	}
	b.reconcileLastByKey[key] = claimedAt
}
