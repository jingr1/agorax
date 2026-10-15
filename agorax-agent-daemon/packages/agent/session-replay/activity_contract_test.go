package sessionreplay

import (
	"strings"
	"testing"
)

// contractIntentByRequirement selects one contract entry dynamically so tests
// keep passing when activity-contract.json values are tuned.
func contractIntentByRequirement(
	t *testing.T,
	requiresEffect bool,
	needsEffectType bool,
) (string, ActivityIntentContract) {
	t.Helper()
	for intentType, intent := range PortableActivityContract.Intents {
		if intent.RequiresEffect != requiresEffect {
			continue
		}
		if needsEffectType && len(intent.Effects) == 0 {
			continue
		}
		return intentType, intent
	}
	t.Fatalf(
		"activity contract has no intent with requiresEffect=%v effects=%v",
		requiresEffect,
		needsEffectType,
	)
	return "", ActivityIntentContract{}
}

func TestPortableActivityContractLoads(t *testing.T) {
	if PortableActivityContract.SchemaVersion != ActivityContractSchemaVersion {
		t.Fatalf(
			"contract schema version = %d, want %d",
			PortableActivityContract.SchemaVersion,
			ActivityContractSchemaVersion,
		)
	}
	if len(PortableActivityContract.Intents) == 0 {
		t.Fatal("contract has no intents")
	}
	intentType, intent := contractIntentByRequirement(t, true, true)
	looked, ok := PortableActivityContract.IntentContract(" " + intentType + " ")
	if !ok || looked.RequiresEffect != intent.RequiresEffect {
		t.Fatalf("IntentContract(%q) = %#v, ok=%v", intentType, looked, ok)
	}
	if !PortableActivityContract.AllowsEffect(intentType, intent.Effects[0]) {
		t.Fatalf("declared effect %q was not allowed for %q", intent.Effects[0], intentType)
	}
	if PortableActivityContract.AllowsEffect(intentType, "not-a-real-effect") {
		t.Fatalf("undeclared effect was allowed for %q", intentType)
	}
	if _, ok := PortableActivityContract.IntentContract("not-a-real-intent"); ok {
		t.Fatal("unknown intent type was found in the contract")
	}
}

func TestValidateActivityContractRejectsInvalidDocuments(t *testing.T) {
	tests := []struct {
		name     string
		contract ActivityContract
		want     string
	}{
		{
			name: "unsupported schema version",
			contract: ActivityContract{
				SchemaVersion: 2,
				Intents: map[string]ActivityIntentContract{
					"submit/requested": {},
				},
			},
			want: "unsupported schema version",
		},
		{
			name:     "no intents",
			contract: ActivityContract{SchemaVersion: ActivityContractSchemaVersion},
			want:     "no intents",
		},
		{
			name: "empty intent type",
			contract: ActivityContract{
				SchemaVersion: ActivityContractSchemaVersion,
				Intents:       map[string]ActivityIntentContract{" ": {}},
			},
			want: "empty intent type",
		},
		{
			name: "empty effect type",
			contract: ActivityContract{
				SchemaVersion: ActivityContractSchemaVersion,
				Intents: map[string]ActivityIntentContract{
					"submit/requested": {Effects: []string{" "}},
				},
			},
			want: "empty effect type",
		},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			err := validateActivityContract(test.contract)
			if err == nil || !strings.Contains(err.Error(), test.want) {
				t.Fatalf("error = %v, want containing %q", err, test.want)
			}
		})
	}
}
