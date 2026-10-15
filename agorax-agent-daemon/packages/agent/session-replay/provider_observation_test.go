package sessionreplay

import "testing"

func TestProviderObservationCommitContextRecordingGeneration(t *testing.T) {
	t.Run("preserves one recording generation", func(t *testing.T) {
		context, err := NewProviderObservationCommitContext(
			[]ProviderObservationBatch{
				{RecordingID: "recording-1"},
				{RecordingID: "recording-1"},
			},
		)
		if err != nil {
			t.Fatal(err)
		}
		if context.RecordingID != "recording-1" {
			t.Fatalf("recording ID = %q", context.RecordingID)
		}
	})

	t.Run("allows non-recording observations", func(t *testing.T) {
		context, err := NewProviderObservationCommitContext(
			[]ProviderObservationBatch{{}},
		)
		if err != nil {
			t.Fatal(err)
		}
		if context.RecordingID != "" {
			t.Fatalf("recording ID = %q", context.RecordingID)
		}
	})

	t.Run("rejects mixed recording generations", func(t *testing.T) {
		_, err := NewProviderObservationCommitContext(
			[]ProviderObservationBatch{
				{RecordingID: "recording-1"},
				{RecordingID: "recording-2"},
			},
		)
		if err == nil {
			t.Fatal("mixed recording generations were accepted")
		}
	})
}
