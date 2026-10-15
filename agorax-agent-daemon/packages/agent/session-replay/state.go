package sessionreplay

import "strings"

type RecordingTransition struct {
	Status       RecordingStatus
	AtUnixMS     int64
	CassetteID   string
	ErrorCode    string
	ErrorMessage string
}

func IsRecordingActive(status RecordingStatus) bool {
	switch status {
	case RecordingStatusPreparing,
		RecordingStatusReady,
		RecordingStatusRecording,
		RecordingStatusFinalizing:
		return true
	default:
		return false
	}
}

func TransitionRecording(recording *Recording, transition RecordingTransition) error {
	if recording == nil || transition.AtUnixMS <= 0 {
		return ErrInvalidState
	}
	if recording.Status == transition.Status {
		return nil
	}
	if !recordingTransitionAllowed(recording.Status, transition.Status) {
		return ErrInvalidState
	}
	switch transition.Status {
	case RecordingStatusRecording:
		if strings.TrimSpace(recording.RootAgentSessionID) == "" {
			return ErrInvalidState
		}
		if recording.RecordingAtUnixMS == 0 {
			recording.RecordingAtUnixMS = transition.AtUnixMS
		}
	case RecordingStatusFinalizing:
		if recording.Status != RecordingStatusRecording {
			return ErrInvalidState
		}
		if recording.StoppedAtUnixMS == 0 {
			recording.StoppedAtUnixMS = transition.AtUnixMS
		}
	case RecordingStatusComplete:
		if strings.TrimSpace(transition.CassetteID) == "" {
			return ErrInvalidState
		}
		recording.CassetteID = strings.TrimSpace(transition.CassetteID)
	case RecordingStatusFailed, RecordingStatusIncomplete:
		if strings.TrimSpace(transition.ErrorCode) == "" ||
			strings.TrimSpace(transition.ErrorMessage) == "" {
			return ErrInvalidState
		}
		recording.ErrorCode = strings.TrimSpace(transition.ErrorCode)
		recording.ErrorMessage = transition.ErrorMessage
	}
	if transition.Status != RecordingStatusFailed &&
		transition.Status != RecordingStatusIncomplete {
		recording.ErrorCode = ""
		recording.ErrorMessage = ""
	}
	recording.Status = transition.Status
	recording.UpdatedAtUnixMS = transition.AtUnixMS
	return nil
}

func recordingTransitionAllowed(from, to RecordingStatus) bool {
	switch from {
	case RecordingStatusPreparing:
		return to == RecordingStatusReady ||
			to == RecordingStatusRecording ||
			to == RecordingStatusFailed ||
			to == RecordingStatusCanceled ||
			to == RecordingStatusIncomplete
	case RecordingStatusReady:
		return to == RecordingStatusRecording ||
			to == RecordingStatusFailed ||
			to == RecordingStatusCanceled ||
			to == RecordingStatusIncomplete
	case RecordingStatusRecording:
		return to == RecordingStatusFinalizing ||
			to == RecordingStatusFailed ||
			to == RecordingStatusCanceled ||
			to == RecordingStatusIncomplete
	case RecordingStatusFinalizing:
		return to == RecordingStatusComplete ||
			to == RecordingStatusFailed ||
			to == RecordingStatusCanceled ||
			to == RecordingStatusIncomplete
	default:
		return false
	}
}
