package sessionreplay

import (
	"encoding/json"
	"errors"
	"fmt"
	"strings"
)

type EntityKind string

const (
	EntityKindSession     EntityKind = "session"
	EntityKindTurn        EntityKind = "turn"
	EntityKindMessage     EntityKind = "message"
	EntityKindToolCall    EntityKind = "tool-call"
	EntityKindInteraction EntityKind = "interaction"
	EntityKindGoal        EntityKind = "goal"
	EntityKindAttachment  EntityKind = "attachment"
)

type EntityOriginSource string

const (
	EntityOriginRecordingRoot       EntityOriginSource = "recording-root"
	EntityOriginInitialState        EntityOriginSource = "initial-state"
	EntityOriginActivityEvent       EntityOriginSource = "activity-event"
	EntityOriginProviderObservation EntityOriginSource = "provider-observation"
)

// EntityOrigin identifies the immutable Cassette fact that first introduced an
// entity. Exactly one source-specific position must be populated.
type EntityOrigin struct {
	Source                EntityOriginSource           `json:"source"`
	InitialStatePath      string                       `json:"initialStatePath,omitempty"`
	ActivityEventSequence uint64                       `json:"activityEventSequence,omitempty"`
	ProviderObservation   *ProviderObservationPosition `json:"providerObservation,omitempty"`
}

// EntityAddress is the portable identity used by checkpoints and commit
// correlations. Runtime and canonical entity IDs are bound to this address by
// the replay runtime and are never part of the Cassette identity.
type EntityAddress struct {
	Kind          EntityKind   `json:"kind"`
	Origin        EntityOrigin `json:"origin"`
	Discriminator string       `json:"discriminator,omitempty"`
}

func ValidateEntityAddress(address EntityAddress) error {
	switch address.Kind {
	case EntityKindSession, EntityKindTurn, EntityKindMessage,
		EntityKindToolCall, EntityKindInteraction, EntityKindGoal,
		EntityKindAttachment:
	default:
		return fmt.Errorf("unsupported entity kind %q", address.Kind)
	}
	if discriminator := strings.TrimSpace(address.Discriminator); discriminator != address.Discriminator {
		return errors.New("entity address discriminator is not normalized")
	}
	origin := address.Origin
	hasInitialState := strings.TrimSpace(origin.InitialStatePath) != ""
	hasActivity := origin.ActivityEventSequence != 0
	hasProvider := origin.ProviderObservation != nil
	switch origin.Source {
	case EntityOriginRecordingRoot:
		if address.Kind != EntityKindSession ||
			address.Discriminator != "" ||
			hasInitialState || hasActivity || hasProvider {
			return errors.New("recording root entity address is invalid")
		}
	case EntityOriginInitialState:
		if !hasInitialState || hasActivity || hasProvider ||
			!strings.HasPrefix(origin.InitialStatePath, "/") {
			return errors.New("initial-state entity address is invalid")
		}
	case EntityOriginActivityEvent:
		if hasInitialState || !hasActivity || hasProvider {
			return errors.New("activity-event entity address is invalid")
		}
	case EntityOriginProviderObservation:
		if hasInitialState || hasActivity || !hasProvider ||
			!validProviderObservationPosition(*origin.ProviderObservation) {
			return errors.New("provider-observation entity address is invalid")
		}
	default:
		return fmt.Errorf("unsupported entity origin %q", origin.Source)
	}
	return nil
}

// EntityAddressKey returns a validated, value-stable map key. Callers must not
// compare EntityAddress directly because ProviderObservation is pointer-backed.
func EntityAddressKey(address EntityAddress) (string, error) {
	if err := ValidateEntityAddress(address); err != nil {
		return "", err
	}
	encoded, err := json.Marshal(address)
	if err != nil {
		return "", err
	}
	return string(encoded), nil
}

func EntityAddressesEqual(left, right EntityAddress) bool {
	return entityAddressEqual(left, right)
}

func validProviderObservationPosition(position ProviderObservationPosition) bool {
	return strings.TrimSpace(position.ConnectionID) != "" &&
		position.ChunkSeq != 0 &&
		position.UnitIndex != 0 &&
		position.EventIndex != 0
}

func entityAddressEqual(left, right EntityAddress) bool {
	if left.Kind != right.Kind ||
		left.Discriminator != right.Discriminator ||
		left.Origin.Source != right.Origin.Source ||
		left.Origin.InitialStatePath != right.Origin.InitialStatePath ||
		left.Origin.ActivityEventSequence != right.Origin.ActivityEventSequence {
		return false
	}
	if left.Origin.ProviderObservation == nil ||
		right.Origin.ProviderObservation == nil {
		return left.Origin.ProviderObservation == nil &&
			right.Origin.ProviderObservation == nil
	}
	return *left.Origin.ProviderObservation == *right.Origin.ProviderObservation
}
