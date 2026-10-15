package sessionreplay

import (
	"context"
	"strings"
)

func (w *Workflow) admitCapture(recordingID string) bool {
	recordingID = strings.TrimSpace(recordingID)
	w.mu.Lock()
	defer w.mu.Unlock()
	if w.active == nil || w.active.ID != recordingID ||
		(w.active.Status != RecordingStatusPreparing &&
			w.active.Status != RecordingStatusReady) {
		return false
	}
	w.captureAdmissionID = recordingID
	return true
}

func (w *Workflow) clearCaptureAdmission(recordingID string) {
	w.mu.Lock()
	defer w.mu.Unlock()
	if w.captureAdmissionID == strings.TrimSpace(recordingID) {
		w.captureAdmissionID = ""
	}
}

func (w *Workflow) RecordProviderInputUnit(
	ctx context.Context,
	recordingID string,
	entry ObservationJournalEntry,
) error {
	snapshot, active, err := w.writeForActiveRecording(
		recordingID,
		func(recording Recording) error {
			return w.Artifacts.AppendObservationJournalEntry(ctx, recording, entry)
		},
	)
	if !active {
		return nil
	}
	if err != nil {
		_ = w.Transport.Cancel(snapshot.RootAgentSessionID)
		_, _ = w.fail(ctx, snapshot.ID, "observation_journal_write_failed", err)
		return err
	}
	return nil
}

func (w *Workflow) RecordingCursorSnapshot() (RecordingCursorSnapshot, bool) {
	if w == nil {
		return RecordingCursorSnapshot{}, false
	}
	w.mu.Lock()
	defer w.mu.Unlock()
	if w.active == nil || w.active.Status != RecordingStatusRecording {
		return RecordingCursorSnapshot{}, false
	}
	return RecordingCursorSnapshot{
		Recording:             cloneRecording(w.active),
		ActivityEventSequence: w.nextActivityEventSeq,
	}, true
}

// RecordingCursorSnapshotForCapture returns only the exact Recording
// generation admitted to receive Provider capture callbacks.
func (w *Workflow) RecordingCursorSnapshotForCapture(
	recordingID string,
) (RecordingCursorSnapshot, bool) {
	recordingID = strings.TrimSpace(recordingID)
	w.mu.Lock()
	defer w.mu.Unlock()
	if !w.captureCallbackAllowedLocked(recordingID) {
		return RecordingCursorSnapshot{}, false
	}
	return RecordingCursorSnapshot{
		Recording:             cloneRecording(w.active),
		ActivityEventSequence: w.nextActivityEventSeq,
	}, true
}

func (w *Workflow) HasRecordingCaptureForScope(scopeID string) bool {
	scopeID = strings.TrimSpace(scopeID)
	w.mu.Lock()
	defer w.mu.Unlock()
	return w.active != nil &&
		w.active.ScopeID == scopeID &&
		w.captureCallbackAllowedLocked(w.active.ID)
}

func (w *Workflow) RecordCheckpointCandidate(
	ctx context.Context,
	recordingID string,
	entry ObservationJournalEntry,
	plan CheckpointPlan,
) error {
	failureCode := "observation_journal_write_failed"
	snapshot, active, err := w.writeForActiveRecording(
		recordingID,
		func(recording Recording) error {
			if err := w.Artifacts.AppendObservationJournalEntry(
				ctx,
				recording,
				entry,
			); err != nil {
				return err
			}
			failureCode = "checkpoint_plan_write_failed"
			return w.Artifacts.WriteCheckpointPlan(ctx, recording, plan)
		},
	)
	if !active {
		return nil
	}
	if err != nil {
		_ = w.Transport.Cancel(snapshot.RootAgentSessionID)
		_, _ = w.fail(ctx, snapshot.ID, failureCode, err)
		return err
	}
	return nil
}

// RecordCheckpointPlan persists a Workflow-owned plan update that is not
// paired with a Provider observation journal entry.
func (w *Workflow) RecordCheckpointPlan(
	ctx context.Context,
	recordingID string,
	plan CheckpointPlan,
) error {
	snapshot, active, err := w.writeForActiveRecording(
		recordingID,
		func(recording Recording) error {
			return w.Artifacts.WriteCheckpointPlan(ctx, recording, plan)
		},
	)
	if !active {
		return nil
	}
	if err != nil {
		_ = w.Transport.Cancel(snapshot.RootAgentSessionID)
		_, _ = w.fail(ctx, snapshot.ID, "checkpoint_plan_write_failed", err)
		return err
	}
	return nil
}

func (w *Workflow) writeForActiveRecording(
	recordingID string,
	write func(Recording) error,
) (Recording, bool, error) {
	recordingID = strings.TrimSpace(recordingID)
	w.mu.Lock()
	defer w.mu.Unlock()
	if !w.captureCallbackAllowedLocked(recordingID) {
		return Recording{}, false, nil
	}
	snapshot := cloneRecording(w.active)
	return snapshot, true, write(snapshot)
}

func (w *Workflow) captureCallbackAllowedLocked(recordingID string) bool {
	if w.active == nil || w.active.ID != strings.TrimSpace(recordingID) {
		return false
	}
	if w.active.Status == RecordingStatusRecording {
		return true
	}
	return w.captureAdmissionID == w.active.ID &&
		(w.active.Status == RecordingStatusPreparing ||
			w.active.Status == RecordingStatusReady)
}
