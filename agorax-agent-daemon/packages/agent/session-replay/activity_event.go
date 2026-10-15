package sessionreplay

import (
	"errors"
	"fmt"
	"strings"
)

type ActivityEventKind string

const (
	ActivityEventKindIntent         ActivityEventKind = "intent"
	ActivityEventKindEffect         ActivityEventKind = "effect"
	ActivityEventKindDirectStimulus ActivityEventKind = "direct-stimulus"
	PortableReplayCWDToken                            = "${REPLAY_CWD}"
)

// ActivityEvent is one fact on the ordered user-activity timeline. Intents
// drive an activity engine during replay. Effects verify commands produced by
// that engine. Direct stimuli drive product operations that have no activity
// engine entrypoint.
type ActivityEvent struct {
	SchemaVersion   int               `json:"schemaVersion"`
	Sequence        uint64            `json:"sequence"`
	Kind            ActivityEventKind `json:"kind"`
	Type            string            `json:"type"`
	EventID         string            `json:"eventId"`
	CorrelationID   string            `json:"correlationId,omitempty"`
	CausedByEventID string            `json:"causedByEventId,omitempty"`
	// ScopeID is capture-only routing context. It is never serialized into a
	// portable Cassette; replay injects its transient product scope.
	ScopeID        string         `json:"-"`
	AgentSessionID string         `json:"agentSessionId,omitempty"`
	Payload        map[string]any `json:"payload,omitempty"`
	OccurredAtMS   int64          `json:"occurredAtUnixMs"`
}

func ValidateActivityEvent(event ActivityEvent) error {
	if event.SchemaVersion != CassetteSchemaVersion {
		return fmt.Errorf("activity event has unsupported schema version %d", event.SchemaVersion)
	}
	if event.Sequence == 0 ||
		strings.TrimSpace(event.Type) == "" ||
		strings.TrimSpace(event.EventID) == "" ||
		event.OccurredAtMS <= 0 {
		return errors.New("activity event is missing required identity or timing")
	}
	switch event.Kind {
	case ActivityEventKindIntent, ActivityEventKindDirectStimulus:
		if strings.TrimSpace(event.CausedByEventID) != "" {
			return fmt.Errorf("%s activity event cannot have causedByEventId", event.Kind)
		}
		if event.Kind == ActivityEventKindIntent {
			if _, ok := PortableActivityContract.IntentContract(event.Type); !ok {
				return fmt.Errorf(
					"intent activity event type %q is not in the activity contract",
					event.Type,
				)
			}
		}
	case ActivityEventKindEffect:
		if strings.TrimSpace(event.CausedByEventID) == "" {
			return errors.New("effect activity event requires causedByEventId")
		}
	default:
		return fmt.Errorf("activity event has unsupported kind %q", event.Kind)
	}
	return nil
}

// ValidateActivityEvents validates one complete activity timeline. An effect
// must point to an earlier intent; it is verification evidence, not a second
// replay driver.
func ValidateActivityEvents(events []ActivityEvent) error {
	seen := make(map[string]ActivityEvent, len(events))
	for position, event := range events {
		if err := ValidateActivityEvent(event); err != nil {
			return fmt.Errorf("activity event %d: %w", position, err)
		}
		wantSequence := uint64(position + 1)
		if event.Sequence != wantSequence {
			return fmt.Errorf(
				"activity event sequence %d is not contiguous at position %d",
				event.Sequence,
				position,
			)
		}
		eventID := strings.TrimSpace(event.EventID)
		if _, ok := seen[eventID]; ok {
			return fmt.Errorf("activity event id %q is duplicated", eventID)
		}
		if event.Kind == ActivityEventKindEffect {
			causeID := strings.TrimSpace(event.CausedByEventID)
			cause, ok := seen[causeID]
			if !ok || cause.Kind != ActivityEventKindIntent {
				return fmt.Errorf(
					"effect activity event %q must reference an earlier intent",
					eventID,
				)
			}
			if !PortableActivityContract.AllowsEffect(cause.Type, event.Type) {
				return fmt.Errorf(
					"effect activity event %q type %q is not allowed for intent type %q",
					eventID,
					event.Type,
					cause.Type,
				)
			}
			correlationID := strings.TrimSpace(event.CorrelationID)
			causeCorrelationID := strings.TrimSpace(cause.CorrelationID)
			if correlationID != "" && causeCorrelationID != "" &&
				correlationID != causeCorrelationID {
				return fmt.Errorf(
					"effect activity event %q conflicts with its intent correlation",
					eventID,
				)
			}
		}
		seen[eventID] = event
	}
	return nil
}

// ValidateActivityTimelineComplete validates one full recorded activity
// timeline: the structural and contract rules of ValidateActivityEvents plus
// completeness. Every intent whose contract type requires an effect must be
// referenced by at least one effect before the recording may publish or a
// cassette may be accepted for replay.
func ValidateActivityTimelineComplete(events []ActivityEvent) error {
	if err := ValidateActivityEvents(events); err != nil {
		return err
	}
	covered := make(map[string]struct{}, len(events))
	for _, event := range events {
		if event.Kind == ActivityEventKindEffect {
			covered[strings.TrimSpace(event.CausedByEventID)] = struct{}{}
		}
	}
	for _, event := range events {
		if event.Kind != ActivityEventKindIntent {
			continue
		}
		intent, _ := PortableActivityContract.IntentContract(event.Type)
		if !intent.RequiresEffect {
			continue
		}
		if _, ok := covered[strings.TrimSpace(event.EventID)]; !ok {
			return fmt.Errorf(
				"intent activity event %q type %q correlation %q requires at least one effect",
				event.EventID,
				event.Type,
				event.CorrelationID,
			)
		}
	}
	return nil
}
