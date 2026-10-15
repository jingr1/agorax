package sessionreplay

import (
	"strings"
	"testing"
)

func validActivityEvent(sequence uint64, kind ActivityEventKind, eventID string) ActivityEvent {
	return ActivityEvent{
		SchemaVersion: CassetteSchemaVersion,
		Sequence:      sequence,
		Kind:          kind,
		Type:          "submit/requested",
		EventID:       eventID,
		ScopeID:       "scope-1",
		OccurredAtMS:  1,
	}
}

func TestValidateActivityEventsAcceptsIntentEffectAndDirectStimulus(t *testing.T) {
	intent := validActivityEvent(1, ActivityEventKindIntent, "intent-1")
	effect := validActivityEvent(2, ActivityEventKindEffect, "effect-1")
	effect.Type = "queue/sendPrompt"
	effect.CausedByEventID = intent.EventID
	direct := validActivityEvent(3, ActivityEventKindDirectStimulus, "direct-1")
	direct.Type = "session.create"
	if err := ValidateActivityEvents([]ActivityEvent{intent, effect, direct}); err != nil {
		t.Fatal(err)
	}
}

func TestValidateActivityEventsRejectsInvalidTimeline(t *testing.T) {
	intent := validActivityEvent(1, ActivityEventKindIntent, "intent-1")
	tests := []struct {
		name   string
		events []ActivityEvent
		want   string
	}{
		{
			name: "non-contiguous sequence",
			events: []ActivityEvent{
				func() ActivityEvent {
					event := intent
					event.Sequence = 2
					return event
				}(),
			},
			want: "not contiguous",
		},
		{
			name: "duplicate event id",
			events: []ActivityEvent{intent, func() ActivityEvent {
				event := validActivityEvent(2, ActivityEventKindIntent, intent.EventID)
				return event
			}()},
			want: "duplicated",
		},
		{
			name: "intent type outside the contract",
			events: []ActivityEvent{
				func() ActivityEvent {
					event := intent
					event.Type = "not-a-real-intent"
					return event
				}(),
			},
			want: "not in the activity contract",
		},
		{
			name: "effect type not declared by its intent",
			events: []ActivityEvent{intent, func() ActivityEvent {
				event := validActivityEvent(2, ActivityEventKindEffect, "effect-1")
				event.Type = "not-a-real-effect"
				event.CausedByEventID = intent.EventID
				return event
			}()},
			want: "not allowed for intent type",
		},
		{
			name: "effect references non-intent",
			events: []ActivityEvent{
				func() ActivityEvent {
					event := intent
					event.Kind = ActivityEventKindDirectStimulus
					return event
				}(),
				func() ActivityEvent {
					event := validActivityEvent(2, ActivityEventKindEffect, "effect-1")
					event.CausedByEventID = intent.EventID
					return event
				}(),
			},
			want: "earlier intent",
		},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			err := ValidateActivityEvents(test.events)
			if err == nil || !strings.Contains(err.Error(), test.want) {
				t.Fatalf("error = %v, want containing %q", err, test.want)
			}
		})
	}
}

func TestValidateActivityTimelineCompleteRequiresEffectCoverage(t *testing.T) {
	intentType, contract := contractIntentByRequirement(t, true, true)
	intent := validActivityEvent(1, ActivityEventKindIntent, "intent-1")
	intent.Type = intentType
	intent.CorrelationID = "correlation-1"

	err := ValidateActivityTimelineComplete([]ActivityEvent{intent})
	if err == nil ||
		!strings.Contains(err.Error(), "requires at least one effect") ||
		!strings.Contains(err.Error(), intent.EventID) ||
		!strings.Contains(err.Error(), intent.Type) ||
		!strings.Contains(err.Error(), intent.CorrelationID) {
		t.Fatalf("incomplete timeline error = %v", err)
	}

	effect := validActivityEvent(2, ActivityEventKindEffect, "effect-1")
	effect.Type = contract.Effects[0]
	effect.CausedByEventID = intent.EventID
	effect.CorrelationID = intent.CorrelationID
	if err := ValidateActivityTimelineComplete(
		[]ActivityEvent{intent, effect},
	); err != nil {
		t.Fatal(err)
	}
}

func TestValidateActivityTimelineCompleteIgnoresDirectStimuli(t *testing.T) {
	optionalType, _ := contractIntentByRequirement(t, false, false)
	optional := validActivityEvent(1, ActivityEventKindIntent, "intent-1")
	optional.Type = optionalType
	direct := validActivityEvent(2, ActivityEventKindDirectStimulus, "direct-1")
	direct.Type = "session.create"
	if err := ValidateActivityTimelineComplete(
		[]ActivityEvent{optional, direct},
	); err != nil {
		t.Fatal(err)
	}
}
