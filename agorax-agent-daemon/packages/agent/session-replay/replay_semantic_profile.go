package sessionreplay

import (
	"errors"
	"fmt"
)

var ErrUnsupportedReplaySemanticDomain = errors.New(
	"replay state requires an unsupported semantic domain",
)

type SemanticProfile struct {
	Agent     bool
	AgoraxMode bool
	Workflows bool
	Issues    bool
}

func AgoraxSemanticProfile() SemanticProfile {
	return SemanticProfile{
		Agent: true, AgoraxMode: true, Workflows: true, Issues: true,
	}
}

func AgentSemanticProfile() SemanticProfile {
	return SemanticProfile{Agent: true}
}

type UnsupportedReplaySemanticDomainError struct {
	Domain string
	Path   string
}

func (e *UnsupportedReplaySemanticDomainError) Error() string {
	return fmt.Sprintf(
		"%s: %s at %s",
		ErrUnsupportedReplaySemanticDomain,
		e.Domain,
		e.Path,
	)
}

func (*UnsupportedReplaySemanticDomainError) Unwrap() error {
	return ErrUnsupportedReplaySemanticDomain
}

func ValidateAgoraxReplayStateForProfile(
	state AgoraxReplayState,
	profile SemanticProfile,
) error {
	if err := validateSemanticProfile(profile); err != nil {
		return err
	}
	if err := ValidateAgoraxReplayState(state); err != nil {
		return err
	}
	if !profile.AgoraxMode {
		if len(state.AgoraxMode.Activations) != 0 {
			return unsupportedReplaySemanticDomain("agoraxMode", "$.agoraxMode.activations")
		}
		for _, snapshot := range state.AgoraxMode.TurnSnapshots {
			if !isUnconfiguredAgoraxModeTurnSnapshot(snapshot) {
				return unsupportedReplaySemanticDomain("agoraxMode", "$.agoraxMode.turnSnapshots")
			}
		}
	}
	if !profile.Workflows && len(state.Workflows) != 0 {
		return unsupportedReplaySemanticDomain("workflows", "$.workflows")
	}
	if !profile.Issues {
		if len(state.Issues) != 0 {
			return unsupportedReplaySemanticDomain("issues", "$.issues")
		}
		for index, workflow := range state.Workflows {
			if len(workflow.IssueIDs) != 0 {
				return unsupportedReplaySemanticDomain(
					"issues",
					fmt.Sprintf("$.workflows[%d].issueIds", index),
				)
			}
		}
	}
	return nil
}

func MergeAgoraxReplayStatesForProfile(
	states []AgoraxReplayState,
	profile SemanticProfile,
) (AgoraxReplayMergedState, error) {
	if err := validateSemanticProfile(profile); err != nil {
		return AgoraxReplayMergedState{}, err
	}
	profileStates := make([]AgoraxReplayState, len(states))
	for index, state := range states {
		if err := ValidateAgoraxReplayStateForProfile(state, profile); err != nil {
			return AgoraxReplayMergedState{}, err
		}
		profileStates[index] = projectAgoraxReplayStateForProfile(state, profile)
	}
	return mergeAgoraxReplayStatesValidated(profileStates)
}

func CompareAgoraxReplayStateForProfile(
	expected AgoraxReplayState,
	actual AgoraxReplayState,
	profile SemanticProfile,
) error {
	if err := ValidateAgoraxReplayStateForProfile(expected, profile); err != nil {
		return fmt.Errorf("invalid expected Agorax Replay State: %w", err)
	}
	if err := ValidateAgoraxReplayStateForProfile(actual, profile); err != nil {
		return fmt.Errorf("invalid actual Agorax Replay State: %w", err)
	}
	return compareAgoraxReplayStateValidated(
		projectAgoraxReplayStateForProfile(expected, profile),
		projectAgoraxReplayStateForProfile(actual, profile),
	)
}

func projectAgoraxReplayStateForProfile(
	state AgoraxReplayState,
	profile SemanticProfile,
) AgoraxReplayState {
	if profile.AgoraxMode {
		return state
	}
	state.AgoraxMode.TurnSnapshots = []AgoraxReplayTurnSnapshot{}
	return state
}

// Agorax records one turn snapshot before dispatch even when Agorax Mode is not
// configured for the Session. That row only proves the absence of Agorax Mode;
// it does not require a consumer to own Agorax Mode product state.
func isUnconfiguredAgoraxModeTurnSnapshot(
	snapshot AgoraxReplayTurnSnapshot,
) bool {
	return snapshot.ActivationID == "" &&
		snapshot.RevisionID == "" &&
		snapshot.Revision == 0 &&
		snapshot.State == "inactive" &&
		snapshot.Source == "" &&
		snapshot.PreferenceVersion == 0 &&
		snapshot.Effect == 0 &&
		snapshot.Speed == 0
}

func validateSemanticProfile(profile SemanticProfile) error {
	if !profile.Agent {
		return errors.New("replay semantic profile must support the Agent domain")
	}
	return nil
}

func unsupportedReplaySemanticDomain(
	domain string,
	path string,
) error {
	return &UnsupportedReplaySemanticDomainError{Domain: domain, Path: path}
}
