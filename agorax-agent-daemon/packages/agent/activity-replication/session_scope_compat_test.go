package activityreplication_test

import (
	"encoding/json"
	"strings"
	"testing"

	activityreplication "agorax.local/agent-daemon/packages/agent/activity-replication"
)

func TestSessionScopeSharedAgentBindingIDIsAdditive(t *testing.T) {
	t.Parallel()

	const legacyJSON = `{"initiatorUserId":"caller-1","executorOwnerUserId":"owner-1","sourceDeviceId":"device-1","launchKind":"shared-agent","visibility":"members"}`
	var legacy activityreplication.SessionScope
	if err := json.Unmarshal([]byte(legacyJSON), &legacy); err != nil {
		t.Fatal(err)
	}
	if legacy.SharedAgentBindingID != "" {
		t.Fatalf("legacy binding id = %q, want empty", legacy.SharedAgentBindingID)
	}

	encoded, err := json.Marshal(activityreplication.SessionScope{
		InitiatorUserID: "caller-1", ExecutorOwnerUserID: "owner-1", SourceDeviceID: "device-1",
		SharedAgentBindingID: "binding-1", LaunchKind: "shared-agent", Visibility: activityreplication.VisibilityMembers,
	})
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(encoded), `"sharedAgentBindingId":"binding-1"`) {
		t.Fatalf("encoded scope = %s", encoded)
	}

	var roundTrip activityreplication.SessionScope
	if err := json.Unmarshal(encoded, &roundTrip); err != nil {
		t.Fatal(err)
	}
	if roundTrip.SharedAgentBindingID != "binding-1" {
		t.Fatalf("round-trip binding id = %q", roundTrip.SharedAgentBindingID)
	}
}

func TestSessionScopeOmitsEmptySharedAgentBindingID(t *testing.T) {
	t.Parallel()

	encoded, err := json.Marshal(activityreplication.SessionScope{
		ExecutorOwnerUserID: "owner-1", SourceDeviceID: "device-1",
		LaunchKind: "direct", Visibility: activityreplication.VisibilityMembers,
	})
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(string(encoded), "sharedAgentBindingId") {
		t.Fatalf("encoded legacy-compatible scope = %s", encoded)
	}
}
