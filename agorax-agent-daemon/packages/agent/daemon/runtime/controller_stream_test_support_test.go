package agentruntime

import (
	"testing"
	"time"

	agentsessionstore "agorax.local/agent-daemon/packages/agent/daemon/activity"
	activityshared "agorax.local/agent-daemon/packages/agent/daemon/activity/events"
)

func waitForPublishedSessionEvent(t *testing.T, events <-chan StreamEvent, eventType string, callType string, status string) StreamEvent {
	t.Helper()
	deadline := time.After(2 * time.Second)
	for {
		select {
		case event := <-events:
			if streamEventMatches(event, eventType, callType, status) {
				return event
			}
		case <-deadline:
			t.Fatalf("expected published event type=%q callType=%q status=%q", eventType, callType, status)
			return StreamEvent{}
		}
	}
}

func waitForStreamEventType(t *testing.T, events <-chan StreamEvent, eventType string) StreamEvent {
	t.Helper()
	deadline := time.After(2 * time.Second)
	for {
		select {
		case event := <-events:
			if event.EventType == eventType {
				return event
			}
		case <-deadline:
			t.Fatalf("expected published stream event type=%q", eventType)
			return StreamEvent{}
		}
	}
}

func waitForStatePatchTitle(t *testing.T, events <-chan StreamEvent, title string) StreamEvent {
	t.Helper()
	deadline := time.After(2 * time.Second)
	for {
		select {
		case event := <-events:
			patch, ok := event.Data.(agentsessionstore.WorkspaceAgentStatePatch)
			if event.EventType == StreamEventStatePatch && ok && patch.Title == title {
				return event
			}
		case <-deadline:
			t.Fatalf("expected published state patch title=%q", title)
			return StreamEvent{}
		}
	}
}

func waitForStatePatchPermissionMode(t *testing.T, events <-chan StreamEvent, permissionModeID string) StreamEvent {
	t.Helper()
	deadline := time.After(2 * time.Second)
	for {
		select {
		case event := <-events:
			patch, ok := event.Data.(agentsessionstore.WorkspaceAgentStatePatch)
			if event.EventType == StreamEventStatePatch && ok && patch.PermissionModeID == permissionModeID {
				return event
			}
		case <-deadline:
			t.Fatalf("expected published state patch permissionModeId=%q", permissionModeID)
			return StreamEvent{}
		}
	}
}

func expectNoStreamEventType(t *testing.T, events <-chan StreamEvent, eventType string) {
	t.Helper()
	select {
	case event := <-events:
		if event.EventType == eventType {
			t.Fatalf("unexpected published stream event type=%q: %#v", eventType, event)
		}
	case <-time.After(100 * time.Millisecond):
	}
}

func streamEventMatches(event StreamEvent, eventType string, callType string, status string) bool {
	switch eventType {
	case EventCallStarted, EventCallCompleted, EventCallFailed:
		update, ok := event.Data.(agentsessionstore.WorkspaceAgentMessageUpdate)
		if event.EventType != StreamEventMessageUpdate || !ok {
			return false
		}
		if update.Kind != "tool_call" {
			return false
		}
		if callType != "" && asString(update.Payload["callType"]) != callType {
			return false
		}
		return status == "" || update.Status == status || asString(update.Payload["status"]) == status
	case EventTurnStarted, EventTurnCompleted:
		patch, ok := event.Data.(agentsessionstore.WorkspaceAgentStatePatch)
		if event.EventType != StreamEventStatePatch || !ok || patch.Turn == nil {
			return false
		}
		if eventType == EventTurnStarted && patch.Turn.StartedAtUnixMS == 0 {
			return false
		}
		if eventType == EventTurnCompleted && patch.Turn.CompletedAtUnixMS == 0 {
			return false
		}
		if status == SessionStatusCanceled {
			return patch.Turn.Outcome == SessionStatusCanceled ||
				patch.Turn.Outcome == string(activityshared.TurnOutcomeInterrupted)
		}
		if status == SessionStatusWorking {
			return patch.CurrentPhase == string(activityshared.TurnPhaseWorking)
		}
		return true
	default:
		return false
	}
}
