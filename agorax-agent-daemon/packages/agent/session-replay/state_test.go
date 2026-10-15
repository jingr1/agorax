package sessionreplay

import (
	"errors"
	"testing"
)

func TestRecordingLifecycle(t *testing.T) {
	recording := &Recording{
		ID:                 "recording-1",
		RootAgentSessionID: "session-1",
		Status:             RecordingStatusPreparing,
		CreatedAtUnixMS:    1,
		UpdatedAtUnixMS:    1,
	}
	for _, transition := range []RecordingTransition{
		{Status: RecordingStatusReady, AtUnixMS: 2},
		{Status: RecordingStatusRecording, AtUnixMS: 3},
		{Status: RecordingStatusFinalizing, AtUnixMS: 4},
		{Status: RecordingStatusComplete, AtUnixMS: 5, CassetteID: "cassette-1"},
	} {
		if err := TransitionRecording(recording, transition); err != nil {
			t.Fatalf("TransitionRecording(%s): %v", transition.Status, err)
		}
	}
	if recording.CassetteID != "cassette-1" ||
		recording.RecordingAtUnixMS != 3 ||
		recording.StoppedAtUnixMS != 4 ||
		recording.UpdatedAtUnixMS != 5 {
		t.Fatalf("recording = %#v", recording)
	}
	if IsRecordingActive(recording.Status) {
		t.Fatal("completed recording is active")
	}
}

func TestRecordingRejectsCompleteWithoutCassette(t *testing.T) {
	recording := &Recording{
		RootAgentSessionID: "session-1",
		Status:             RecordingStatusFinalizing,
	}
	err := TransitionRecording(recording, RecordingTransition{
		Status:   RecordingStatusComplete,
		AtUnixMS: 1,
	})
	if !errors.Is(err, ErrInvalidState) {
		t.Fatalf("error = %v", err)
	}
}
