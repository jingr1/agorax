package sessionreplay

import (
	_ "embed"
	"encoding/json"
	"errors"
	"fmt"
	"slices"
	"strings"
)

const ActivityContractSchemaVersion = 1

// ActivityIntentContract declares the replayable command surface of one
// intent type: the effect types its engine run may emit, and whether the
// timeline is complete only when at least one effect references the intent.
type ActivityIntentContract struct {
	Effects        []string `json:"effects"`
	RequiresEffect bool     `json:"requiresEffect"`
}

// ActivityContract is the shared intent/effect vocabulary. Values live in
// activity-contract.json so every consumer reads one cross-language source
// instead of hard-coding intent or effect types.
type ActivityContract struct {
	SchemaVersion int                               `json:"schemaVersion"`
	Intents       map[string]ActivityIntentContract `json:"intents"`
}

//go:embed activity-contract.json
var activityContractJSON []byte

var PortableActivityContract = mustActivityContract()

func mustActivityContract() ActivityContract {
	var contract ActivityContract
	if err := json.Unmarshal(activityContractJSON, &contract); err != nil {
		panic(err)
	}
	if err := validateActivityContract(contract); err != nil {
		panic(err)
	}
	return contract
}

func validateActivityContract(contract ActivityContract) error {
	if contract.SchemaVersion != ActivityContractSchemaVersion {
		return fmt.Errorf(
			"activity contract has unsupported schema version %d",
			contract.SchemaVersion,
		)
	}
	if len(contract.Intents) == 0 {
		return errors.New("activity contract has no intents")
	}
	for intentType, intent := range contract.Intents {
		if strings.TrimSpace(intentType) == "" {
			return errors.New("activity contract has an empty intent type")
		}
		for _, effectType := range intent.Effects {
			if strings.TrimSpace(effectType) == "" {
				return fmt.Errorf(
					"activity contract intent %q has an empty effect type",
					intentType,
				)
			}
		}
	}
	return nil
}

// IntentContract returns the contract entry for one intent type.
func (c ActivityContract) IntentContract(intentType string) (ActivityIntentContract, bool) {
	intent, ok := c.Intents[strings.TrimSpace(intentType)]
	return intent, ok
}

// AllowsEffect reports whether effectType is a declared effect of intentType.
func (c ActivityContract) AllowsEffect(intentType, effectType string) bool {
	intent, ok := c.IntentContract(intentType)
	return ok && slices.Contains(intent.Effects, strings.TrimSpace(effectType))
}
