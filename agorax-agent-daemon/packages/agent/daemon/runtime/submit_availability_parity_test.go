package agentruntime

import "testing"

// PARITY TABLE: mirrored in TypeScript at
// packages/agent/activity-core/src/selectors.test.ts
// (deriveSubmitAvailabilityParityCases) — keep the two tables identical. The
// GUI derives submit availability locally from turnLifecycle, and this table
// pins both derivations to the same semantics.
// (The TS side additionally treats an activeTurnId without a phase as a live
// turn — a defensive case the daemon never emits.)
func TestSubmitAvailabilityForAuthoritySessionParity(t *testing.T) {
	t.Parallel()

	turnID := "turn-1"
	cases := []struct {
		name           string
		lifecycle      *TurnLifecycle
		expectedState  string
		expectedReason string
	}{
		{
			name:          "no lifecycle -> available (token fallbacks live in the callers)",
			expectedState: "available",
		},
		{
			name:           "running turn -> blocked/active_turn",
			lifecycle:      &TurnLifecycle{ActiveTurnID: &turnID, Phase: "running"},
			expectedState:  "blocked",
			expectedReason: "active_turn",
		},
		{
			name:           "submitted turn -> blocked/active_turn",
			lifecycle:      &TurnLifecycle{ActiveTurnID: &turnID, Phase: "submitted"},
			expectedState:  "blocked",
			expectedReason: "active_turn",
		},
		{
			name:           "waiting_approval -> blocked/waiting",
			lifecycle:      &TurnLifecycle{ActiveTurnID: &turnID, Phase: "waiting_approval"},
			expectedState:  "blocked",
			expectedReason: "waiting",
		},
		{
			name:           "legacy awaiting_approval -> blocked/waiting",
			lifecycle:      &TurnLifecycle{ActiveTurnID: &turnID, Phase: "awaiting_approval"},
			expectedState:  "blocked",
			expectedReason: "waiting",
		},
		{
			name:          "settled -> available",
			lifecycle:     &TurnLifecycle{Phase: "settled"},
			expectedState: "available",
		},
		{
			name:          "settled with stale activeTurnId -> available",
			lifecycle:     &TurnLifecycle{ActiveTurnID: &turnID, Phase: "settled"},
			expectedState: "available",
		},
	}

	for _, tt := range cases {
		t.Run(tt.name, func(t *testing.T) {
			t.Parallel()

			session := Session{
				TurnLifecycle: tt.lifecycle,
			}
			availability := submitAvailabilityForAuthoritySession(session)
			if availability == nil {
				t.Fatal("submitAvailabilityForAuthoritySession returned nil")
			}
			if availability.State != tt.expectedState || availability.Reason != tt.expectedReason {
				t.Fatalf(
					"availability = %s/%s, want %s/%s",
					availability.State, availability.Reason,
					tt.expectedState, tt.expectedReason,
				)
			}
		})
	}
}
