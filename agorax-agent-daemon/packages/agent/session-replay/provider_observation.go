package sessionreplay

import (
	"errors"
	"strings"
)

// ProviderObservationBatch is noncanonical Replay metadata attached to one
// durable report commit. Store command DTOs must never persist or interpret it.
type ProviderObservationBatch struct {
	RecordingID  string
	ConnectionID string
	ChunkSeq     uint64
	UnitIndex    uint64
	UnitKind     string
	Events       []ProviderObservationEvent
}

type ProviderObservationEvent struct {
	EventIndex           uint64
	Type                 string
	AgentSessionID       string
	SessionKind          string
	RootAgentSessionID   string
	RootTurnID           string
	ParentAgentSessionID string
	ParentTurnID         string
	ParentToolCallID     string
	TurnID               string
	MessageID            string
	MessageKind          string
	NoticeCommand        string
	NoticeCommandStatus  string
	AttachmentCount      uint64
	CallID               string
	InteractionID        string
	InteractionKind      string
	TurnPhase            string
	TurnOutcome          string
	Status               string
}

type ProviderObservationCommitContext struct {
	RecordingID string
	Batches     []ProviderObservationBatch
}

func NewProviderObservationCommitContext(
	batches []ProviderObservationBatch,
) (ProviderObservationCommitContext, error) {
	context := ProviderObservationCommitContext{Batches: batches}
	if len(batches) > 0 {
		context.RecordingID = strings.TrimSpace(batches[0].RecordingID)
	}
	if err := ValidateProviderObservationCommitContext(context); err != nil {
		return ProviderObservationCommitContext{}, err
	}
	return context, nil
}

func ValidateProviderObservationCommitContext(
	context ProviderObservationCommitContext,
) error {
	recordingID := strings.TrimSpace(context.RecordingID)
	if len(context.Batches) == 0 {
		if recordingID != "" {
			return errors.New(
				"provider observation commit context has no batches",
			)
		}
		return nil
	}
	for _, batch := range context.Batches {
		if strings.TrimSpace(batch.RecordingID) != recordingID {
			return errors.New(
				"provider observation batches cross Recording generations",
			)
		}
	}
	return nil
}
