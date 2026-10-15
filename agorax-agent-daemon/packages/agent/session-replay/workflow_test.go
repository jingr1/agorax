package sessionreplay

import (
	"context"
	"errors"
	"fmt"
	"slices"
	"strings"
	"testing"
	"time"
)

type workflowStore struct {
	recordings map[string]Recording
	cassettes  map[string]Cassette
}

func newWorkflowStore() *workflowStore {
	return &workflowStore{
		recordings: map[string]Recording{},
		cassettes:  map[string]Cassette{},
	}
}

func (s *workflowStore) PutRecording(_ context.Context, value Recording) error {
	value.ArtifactKey = ""
	s.recordings[value.ID] = value
	return nil
}
func (s *workflowStore) DeleteRecording(_ context.Context, id string) error {
	for cassetteID, cassette := range s.cassettes {
		if cassette.SourceRecordingID == id {
			delete(s.cassettes, cassetteID)
		}
	}
	delete(s.recordings, id)
	return nil
}
func (s *workflowStore) GetRecording(_ context.Context, id string) (Recording, error) {
	value, ok := s.recordings[id]
	if !ok {
		return Recording{}, ErrRecordingNotFound
	}
	return value, nil
}
func (s *workflowStore) ListRecordings(_ context.Context, scopeID string) ([]Recording, error) {
	var result []Recording
	for _, value := range s.recordings {
		if scopeID == "" || value.ScopeID == scopeID {
			result = append(result, value)
		}
	}
	return result, nil
}
func (s *workflowStore) PublishCassette(
	ctx context.Context,
	recording Recording,
	cassette Cassette,
) error {
	if err := s.PutRecording(ctx, recording); err != nil {
		return err
	}
	cassette.ArtifactKey = ""
	s.cassettes[cassette.ID] = cassette
	return nil
}
func (s *workflowStore) UpdateCassette(
	ctx context.Context,
	recording Recording,
	cassette Cassette,
) error {
	return s.PublishCassette(ctx, recording, cassette)
}
func (s *workflowStore) GetCassette(_ context.Context, id string) (Cassette, error) {
	value, ok := s.cassettes[id]
	if !ok {
		return Cassette{}, ErrCassetteNotFound
	}
	return value, nil
}
func (s *workflowStore) ListCassettes(_ context.Context, scopeID string) ([]Cassette, error) {
	var result []Cassette
	for _, value := range s.cassettes {
		recording := s.recordings[value.SourceRecordingID]
		if scopeID == "" || recording.ScopeID == scopeID {
			result = append(result, value)
		}
	}
	return result, nil
}

type workflowFixtures struct {
	events *[]string
	root   string
}

func (f workflowFixtures) ResolveRootAgentSession(
	_ context.Context,
	_ string,
	sessionID string,
) (string, error) {
	if f.root != "" {
		return f.root, nil
	}
	return sessionID, nil
}
func (f workflowFixtures) CaptureReplayState(
	_ context.Context,
	_ string,
	_ string,
) ([]byte, error) {
	*f.events = append(*f.events, "state")
	return []byte(`{"schemaVersion":1}`), nil
}
func (f workflowFixtures) WaitAgentSessionGraphSettled(
	context.Context,
	string,
	string,
) error {
	*f.events = append(*f.events, "settle")
	return nil
}

type workflowArtifacts struct {
	events          *[]string
	activityEvents  []ActivityEvent
	cassettes       map[string]Cassette
	resolveErrors   map[string]error
	journalEntries  []ObservationJournalEntry
	checkpointPlans []CheckpointPlan
}

func (a *workflowArtifacts) layout(recordingID string) ArtifactLayout {
	return ArtifactLayout{
		StorageKey:       "candidate/" + recordingID,
		ProviderTapeKey:  "candidate/" + recordingID + "/provider",
		InitialStateKey:  "candidate/" + recordingID + "/initial-state.json",
		ExpectedStateKey: "candidate/" + recordingID + "/expected",
	}
}
func (a *workflowArtifacts) Prepare(_ context.Context, recording Recording) (ArtifactLayout, error) {
	*a.events = append(*a.events, "prepare")
	return a.layout(recording.ID), nil
}
func (a *workflowArtifacts) LocateRecording(
	_ context.Context,
	recording Recording,
) (ArtifactLayout, error) {
	if recording.CassetteID != "" {
		layout := a.layout(recording.CassetteID)
		layout.StorageKey = "cassette/" + recording.CassetteID
		return layout, nil
	}
	return a.layout(recording.ID), nil
}
func (a *workflowArtifacts) AppendActivityEvent(
	_ context.Context,
	_ Recording,
	event ActivityEvent,
) error {
	a.activityEvents = append(a.activityEvents, event)
	*a.events = append(*a.events, fmt.Sprintf("event:%d", event.Sequence))
	return nil
}
func (a *workflowArtifacts) AppendObservationJournalEntry(
	_ context.Context,
	_ Recording,
	entry ObservationJournalEntry,
) error {
	a.journalEntries = append(a.journalEntries, entry)
	return nil
}
func (a *workflowArtifacts) WriteCheckpointPlan(
	_ context.Context,
	_ Recording,
	plan CheckpointPlan,
) error {
	a.checkpointPlans = append(a.checkpointPlans, plan)
	return nil
}
func (a *workflowArtifacts) WriteReplayState(
	_ context.Context,
	_ Recording,
	phase ReplayStatePhase,
	_ []byte,
) error {
	*a.events = append(*a.events, "write-state:"+string(phase))
	return nil
}
func (a *workflowArtifacts) Publish(
	_ context.Context,
	recording Recording,
	cassetteID string,
	_ uint64,
) (Artifact, error) {
	*a.events = append(*a.events, "publish")
	cassette := Cassette{
		ID:                 cassetteID,
		Name:               recording.Name,
		SourceRecordingID:  recording.ID,
		AgentTargetID:      recording.AgentTargetID,
		RootAgentSessionID: recording.RootAgentSessionID,
		Mode:               recording.Mode,
		ArtifactKey:        "cassette/" + cassetteID,
		CreatedAtUnixMS:    10,
	}
	if a.cassettes == nil {
		a.cassettes = map[string]Cassette{}
	}
	a.cassettes[cassette.ID] = cassette
	return Artifact{
		Cassette: cassette,
		Layout:   ArtifactLayout{StorageKey: cassette.ArtifactKey},
	}, nil
}
func (a *workflowArtifacts) RenameCassette(
	_ context.Context,
	requested Cassette,
	name string,
) (Artifact, error) {
	cassette, ok := a.cassettes[requested.ID]
	if !ok {
		return Artifact{}, ErrCassetteNotFound
	}
	cassette.Name = name
	cassette.ManifestSHA256 = "renamed"
	a.cassettes[cassette.ID] = cassette
	return Artifact{
		Cassette: cassette,
		Layout:   ArtifactLayout{StorageKey: cassette.ArtifactKey},
	}, nil
}
func (a *workflowArtifacts) RollbackPublish(
	_ context.Context,
	_ Artifact,
	_ Recording,
) error {
	*a.events = append(*a.events, "rollback-publish")
	return nil
}
func (a *workflowArtifacts) Resolve(_ context.Context, requested Cassette) (Artifact, error) {
	if err := a.resolveErrors[requested.ID]; err != nil {
		return Artifact{}, err
	}
	cassette, ok := a.cassettes[requested.ID]
	if !ok {
		return Artifact{}, ErrCassetteNotFound
	}
	return Artifact{
		Cassette: cassette,
		Layout:   ArtifactLayout{StorageKey: cassette.ArtifactKey},
	}, nil
}
func (a *workflowArtifacts) DiscardRecording(_ context.Context, id string) error {
	*a.events = append(*a.events, "discard:"+id)
	return nil
}
func (a *workflowArtifacts) DiscardCassette(_ context.Context, id string) error {
	delete(a.cassettes, id)
	*a.events = append(*a.events, "discard-cassette:"+id)
	return nil
}

type workflowRecorder struct {
	events *[]string
	onArm  func(recordingID string) error
}

func (r workflowRecorder) Arm(root, recordingID, _ string) error {
	*r.events = append(*r.events, "arm:"+root)
	if r.onArm != nil {
		return r.onArm(recordingID)
	}
	return nil
}
func (r workflowRecorder) Complete(root string) error {
	*r.events = append(*r.events, "transport-complete:"+root)
	return nil
}
func (r workflowRecorder) Cancel(root string) error {
	*r.events = append(*r.events, "transport-cancel:"+root)
	return nil
}

func newWorkflowForTest(ids ...string) (*Workflow, *workflowStore, *workflowArtifacts, *[]string) {
	store := newWorkflowStore()
	events := &[]string{}
	artifacts := &workflowArtifacts{events: events}
	next := 0
	now := int64(1)
	return &Workflow{
		States:    workflowFixtures{events: events, root: "root-1"},
		Artifacts: artifacts,
		Transport: workflowRecorder{events: events},
		Store:     store,
		NewID: func() string {
			value := ids[next]
			next++
			return value
		},
		Now: func() time.Time {
			now++
			return time.UnixMilli(now)
		},
	}, store, artifacts, events
}

func TestRecordingWorkflowOwnsCreateBindStimuliAndCompleteOrder(t *testing.T) {
	workflow, store, artifacts, events := newWorkflowForTest("recording-1", "cassette-1")
	recording, err := workflow.Start(context.Background(), StartRecordingInput{
		ScopeID: "scope-1", AgentTargetID: "target-1",
	})
	if err != nil {
		t.Fatal(err)
	}
	if recording.Status != RecordingStatusReady {
		t.Fatalf("recording = %#v", recording)
	}
	recording, err = workflow.Bind(context.Background(), BindRecordingInput{
		RecordingID: "recording-1", ScopeID: "scope-1",
		AgentTargetID: "target-1", AgentSessionID: "root-1",
	})
	if err != nil {
		t.Fatal(err)
	}
	if err := workflow.RecordProviderInputUnit(
		context.Background(),
		recording.ID,
		ObservationJournalEntry{
			SchemaVersion: ObservationSchemaVersion,
			Position: ProviderUnitPosition{
				ConnectionID: "connection-1",
				ChunkSeq:     4,
				UnitIndex:    1,
			},
			UnitKind: ProviderInputUnitProtocolMessage,
		},
	); err != nil {
		t.Fatal(err)
	}
	if len(artifacts.journalEntries) != 1 ||
		artifacts.journalEntries[0].SchemaVersion != ObservationSchemaVersion {
		t.Fatalf("journal entries = %#v", artifacts.journalEntries)
	}
	if err := workflow.RecordCheckpointPlan(
		context.Background(),
		recording.ID,
		NewCheckpointPlan([]ReplayCheckpoint{{
			Kind:    "replay.bootstrap",
			Tags:    []string{"replay.bootstrap"},
			Trigger: CheckpointTrigger{Source: CheckpointTriggerBootstrap},
		}}),
	); err != nil {
		t.Fatal(err)
	}
	if len(artifacts.checkpointPlans) != 1 {
		t.Fatalf("checkpoint plans = %#v", artifacts.checkpointPlans)
	}
	if err := workflow.RecordCheckpointPlan(
		context.Background(),
		"stale-recording",
		NewCheckpointPlan(nil),
	); err != nil {
		t.Fatal(err)
	}
	if len(artifacts.checkpointPlans) != 1 {
		t.Fatalf("stale checkpoint plan was written: %#v", artifacts.checkpointPlans)
	}
	batch := []ActivityEvent{
		{
			Kind: ActivityEventKindIntent, Type: "submit/requested",
			EventID: "submit-root-1", ScopeID: "scope-1", AgentSessionID: "root-1",
		},
		{
			Kind: ActivityEventKindEffect, Type: "queue/sendPrompt",
			EventID: "send-root-1", CausedByEventID: "submit-root-1",
			ScopeID: "scope-1", AgentSessionID: "child-1",
		},
	}
	acceptedThrough, err := workflow.RecordActivityEvents(context.Background(), batch)
	if err != nil {
		t.Fatal(err)
	}
	if acceptedThrough != 2 {
		t.Fatalf("accepted through = %d, want 2", acceptedThrough)
	}
	acceptedThrough, err = workflow.RecordActivityEvents(context.Background(), batch)
	if err != nil || acceptedThrough != 2 || len(artifacts.activityEvents) != 2 {
		t.Fatalf(
			"idempotent batch: accepted=%d events=%d error=%v",
			acceptedThrough,
			len(artifacts.activityEvents),
			err,
		)
	}
	conflict := batch[0]
	conflict.Type = "queue/removed"
	if err := workflow.RecordActivityEvent(context.Background(), conflict); err == nil ||
		!strings.Contains(err.Error(), "conflicts") {
		t.Fatalf("conflicting retry error = %v", err)
	}
	if err := workflow.RecordActivityEvent(context.Background(), ActivityEvent{
		Type: "session.send", ScopeID: "other-scope", AgentSessionID: "root-1",
	}); err != nil {
		t.Fatal(err)
	}
	recording, err = workflow.Complete(context.Background(), recording.ID)
	if err != nil {
		t.Fatal(err)
	}
	if recording.Status != RecordingStatusComplete ||
		recording.CassetteID != "cassette-1" ||
		len(artifacts.activityEvents) != 2 ||
		artifacts.activityEvents[0].Sequence != 1 ||
		artifacts.activityEvents[1].Sequence != 2 {
		t.Fatalf("recording=%#v activityEvents=%#v", recording, artifacts.activityEvents)
	}
	if recording.Name != "1970-01-01T00:00:00.002Z" {
		t.Fatalf("recording name = %q", recording.Name)
	}
	if _, ok := store.cassettes["cassette-1"]; !ok {
		t.Fatal("cassette metadata was not committed")
	}
	wantOrder := []string{
		"prepare",
		"arm:root-1",
		"event:1",
		"event:2",
		"settle",
		"transport-complete:root-1",
		"state",
		"write-state:expected",
		"publish",
	}
	if !slices.Equal(*events, wantOrder) {
		t.Fatalf("events = %#v, want %#v", *events, wantOrder)
	}
}

func TestRecordingWorkflowRejectsContractViolationsAtRecordTime(t *testing.T) {
	ctx := context.Background()
	workflow, _, artifacts, _ := newWorkflowForTest("recording-1")
	if _, err := workflow.Start(ctx, StartRecordingInput{
		ScopeID: "scope-1", AgentTargetID: "target-1", AgentSessionID: "root-1",
	}); err != nil {
		t.Fatal(err)
	}
	if err := workflow.RecordActivityEvent(ctx, ActivityEvent{
		Kind: ActivityEventKindIntent, Type: "not-a-real-intent",
		EventID: "intent-1", ScopeID: "scope-1", AgentSessionID: "root-1",
	}); err == nil || !strings.Contains(err.Error(), "not in the activity contract") {
		t.Fatalf("unknown intent type error = %v", err)
	}
	intentType, _ := contractIntentByRequirement(t, false, false)
	if err := workflow.RecordActivityEvent(ctx, ActivityEvent{
		Kind: ActivityEventKindIntent, Type: intentType,
		EventID: "intent-2", ScopeID: "scope-1", AgentSessionID: "root-1",
	}); err != nil {
		t.Fatal(err)
	}
	if err := workflow.RecordActivityEvent(ctx, ActivityEvent{
		Kind: ActivityEventKindEffect, Type: "not-a-real-effect",
		EventID: "effect-1", CausedByEventID: "intent-2",
		ScopeID: "scope-1", AgentSessionID: "root-1",
	}); err == nil || !strings.Contains(err.Error(), "not allowed for intent type") {
		t.Fatalf("disallowed effect type error = %v", err)
	}
	if len(artifacts.activityEvents) != 1 ||
		artifacts.activityEvents[0].Sequence != 1 ||
		artifacts.activityEvents[0].EventID != "intent-2" {
		t.Fatalf("accepted activity events = %#v", artifacts.activityEvents)
	}
}

func TestRecordingWorkflowCompleteFailsOnIncompleteActivityTimeline(t *testing.T) {
	ctx := context.Background()
	workflow, store, _, events := newWorkflowForTest("recording-1", "cassette-1")
	recording, err := workflow.Start(ctx, StartRecordingInput{
		ScopeID: "scope-1", AgentTargetID: "target-1", AgentSessionID: "root-1",
	})
	if err != nil {
		t.Fatal(err)
	}
	intentType, _ := contractIntentByRequirement(t, true, true)
	if err := workflow.RecordActivityEvent(ctx, ActivityEvent{
		Kind: ActivityEventKindIntent, Type: intentType,
		EventID: "intent-1", CorrelationID: "correlation-1",
		ScopeID: "scope-1", AgentSessionID: "root-1",
	}); err != nil {
		t.Fatal(err)
	}
	if _, err := workflow.Complete(ctx, recording.ID); err == nil ||
		!strings.Contains(err.Error(), "requires at least one effect") {
		t.Fatalf("Complete error = %v", err)
	}
	failed := store.recordings[recording.ID]
	if failed.Status != RecordingStatusFailed ||
		failed.ErrorCode != "activity_timeline_incomplete" {
		t.Fatalf("failed recording = %#v", failed)
	}
	if slices.Contains(*events, "publish") {
		t.Fatalf("incomplete timeline was published: %#v", *events)
	}
}

func TestRecordingWorkflowIgnoresStaleProviderWritesAfterCancelAndRestart(
	t *testing.T,
) {
	ctx := context.Background()
	workflow, _, artifacts, _ := newWorkflowForTest(
		"recording-1",
		"recording-2",
	)
	first, err := workflow.Start(ctx, StartRecordingInput{
		ScopeID: "scope-1", AgentTargetID: "target-1",
	})
	if err != nil {
		t.Fatal(err)
	}
	first, err = workflow.Bind(ctx, BindRecordingInput{
		RecordingID: first.ID, ScopeID: "scope-1",
		AgentTargetID: "target-1", AgentSessionID: "root-1",
	})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := workflow.Cancel(ctx, first.ID); err != nil {
		t.Fatal(err)
	}
	second, err := workflow.Start(ctx, StartRecordingInput{
		ScopeID: "scope-1", AgentTargetID: "target-1",
	})
	if err != nil {
		t.Fatal(err)
	}
	second, err = workflow.Bind(ctx, BindRecordingInput{
		RecordingID: second.ID, ScopeID: "scope-1",
		AgentTargetID: "target-1", AgentSessionID: "root-1",
	})
	if err != nil {
		t.Fatal(err)
	}

	entry := ObservationJournalEntry{
		SchemaVersion: ObservationSchemaVersion,
		Position: ProviderUnitPosition{
			ConnectionID: "connection-1",
			ChunkSeq:     1,
			UnitIndex:    1,
		},
		UnitKind: ProviderInputUnitProtocolMessage,
	}
	if err := workflow.RecordProviderInputUnit(ctx, first.ID, entry); err != nil {
		t.Fatal(err)
	}
	if err := workflow.RecordCheckpointCandidate(
		ctx,
		first.ID,
		entry,
		NewCheckpointPlan(nil),
	); err != nil {
		t.Fatal(err)
	}
	if len(artifacts.journalEntries) != 0 ||
		len(artifacts.checkpointPlans) != 0 {
		t.Fatalf(
			"stale provider writes reached recording %q: journal=%d plans=%d",
			second.ID,
			len(artifacts.journalEntries),
			len(artifacts.checkpointPlans),
		)
	}
}

func TestRecordingWorkflowRenamesCompletedCassette(t *testing.T) {
	workflow, store, artifacts, _ := newWorkflowForTest("recording-1", "cassette-1")
	recording, err := workflow.Start(context.Background(), StartRecordingInput{
		ScopeID: "scope-1", AgentTargetID: "target-1", AgentSessionID: "root-1",
	})
	if err != nil {
		t.Fatal(err)
	}
	recording, err = workflow.Complete(context.Background(), recording.ID)
	if err != nil {
		t.Fatal(err)
	}
	recording, err = workflow.Rename(context.Background(), recording.ID, "checkout regression")
	if err != nil {
		t.Fatal(err)
	}
	if recording.Name != "checkout regression" ||
		store.cassettes[recording.CassetteID].Name != "checkout regression" ||
		artifacts.cassettes[recording.CassetteID].Name != "checkout regression" {
		t.Fatalf("renamed recording = %#v", recording)
	}
}

func TestRecordingWorkflowDeletesCompletedRecordingAndCassette(t *testing.T) {
	workflow, store, artifacts, events := newWorkflowForTest("recording-1", "cassette-1")
	recording, err := workflow.Start(context.Background(), StartRecordingInput{
		ScopeID: "scope-1", AgentTargetID: "target-1", AgentSessionID: "root-1",
	})
	if err != nil {
		t.Fatal(err)
	}
	recording, err = workflow.Complete(context.Background(), recording.ID)
	if err != nil {
		t.Fatal(err)
	}
	if err := workflow.Delete(context.Background(), recording.ID); err != nil {
		t.Fatal(err)
	}
	if _, ok := store.recordings[recording.ID]; ok {
		t.Fatal("recording metadata still exists")
	}
	if _, ok := store.cassettes[recording.CassetteID]; ok {
		t.Fatal("cassette metadata still exists")
	}
	if _, ok := artifacts.cassettes[recording.CassetteID]; ok {
		t.Fatal("cassette artifact still exists")
	}
	if !slices.Contains(*events, "discard-cassette:"+recording.CassetteID) {
		t.Fatalf("events = %#v", *events)
	}
}

func TestRecordingWorkflowRejectsDeletingActiveRecording(t *testing.T) {
	workflow, store, _, _ := newWorkflowForTest("recording-1")
	recording, err := workflow.Start(context.Background(), StartRecordingInput{
		ScopeID: "scope-1", AgentTargetID: "target-1",
	})
	if err != nil {
		t.Fatal(err)
	}
	if err := workflow.Delete(context.Background(), recording.ID); !errors.Is(err, ErrInvalidState) {
		t.Fatalf("Delete error = %v, want ErrInvalidState", err)
	}
	if _, ok := store.recordings[recording.ID]; !ok {
		t.Fatal("active recording metadata was deleted")
	}
}

func TestRecordingWorkflowCapturesContinueSeedBeforeArm(t *testing.T) {
	workflow, _, _, events := newWorkflowForTest("recording-1")
	recording, err := workflow.Start(context.Background(), StartRecordingInput{
		ScopeID: "scope-1", AgentTargetID: "target-1", AgentSessionID: "child-1",
	})
	if err != nil {
		t.Fatal(err)
	}
	if recording.Mode != ScenarioModeContinueSession ||
		recording.Status != RecordingStatusRecording {
		t.Fatalf("recording = %#v", recording)
	}
	want := []string{
		"prepare",
		"state",
		"write-state:initial",
		"arm:root-1",
	}
	if !slices.Equal(*events, want) {
		t.Fatalf("events = %#v, want %#v", *events, want)
	}
	initial, found := workflow.InitialReplayStateSnapshot(recording.ID)
	if !found || string(initial) != `{"schemaVersion":1}` {
		t.Fatalf("initial state = %q, found=%v", initial, found)
	}
	initial[0] = '!'
	again, found := workflow.InitialReplayStateSnapshot(recording.ID)
	if !found || string(again) != `{"schemaVersion":1}` {
		t.Fatalf("initial state snapshot was not isolated: %q", again)
	}
}

func TestRecordingWorkflowAdmitsSynchronousArmCapture(t *testing.T) {
	for _, test := range []struct {
		name            string
		continueSession bool
	}{
		{name: "create"},
		{name: "continue", continueSession: true},
	} {
		t.Run(test.name, func(t *testing.T) {
			workflow, _, artifacts, events := newWorkflowForTest("recording-1")
			workflow.Transport = workflowRecorder{
				events: events,
				onArm: func(recordingID string) error {
					snapshot, ok := workflow.RecordingCursorSnapshotForCapture(recordingID)
					if !ok || snapshot.Recording.ID != recordingID {
						t.Fatalf("capture snapshot = %#v, ok=%v", snapshot, ok)
					}
					if test.continueSession {
						if _, ok := workflow.InitialReplayStateSnapshot(recordingID); !ok {
							t.Fatal("initial replay state was unavailable inside Arm")
						}
					}
					return workflow.RecordProviderInputUnit(
						context.Background(),
						recordingID,
						ObservationJournalEntry{},
					)
				},
			}

			input := StartRecordingInput{
				ScopeID: "scope-1", AgentTargetID: "target-1",
			}
			if test.continueSession {
				input.AgentSessionID = "child-1"
			}
			recording, err := workflow.Start(context.Background(), input)
			if err != nil {
				t.Fatal(err)
			}
			if !test.continueSession {
				recording, err = workflow.Bind(context.Background(), BindRecordingInput{
					RecordingID: recording.ID,
					ScopeID:     "scope-1", AgentTargetID: "target-1",
					AgentSessionID: "root-1",
				})
				if err != nil {
					t.Fatal(err)
				}
			}
			if recording.Status != RecordingStatusRecording {
				t.Fatalf("recording status = %q", recording.Status)
			}
			if len(artifacts.journalEntries) != 1 {
				t.Fatalf("journal entries = %d, want 1", len(artifacts.journalEntries))
			}
			if workflow.captureAdmissionID != "" {
				t.Fatalf("capture admission remained %q", workflow.captureAdmissionID)
			}
		})
	}
}

func TestRecordingWorkflowClearsCaptureAdmissionAfterArmFailure(t *testing.T) {
	workflow, _, artifacts, events := newWorkflowForTest("recording-1")
	armErr := errors.New("arm failed")
	workflow.Transport = workflowRecorder{
		events: events,
		onArm: func(recordingID string) error {
			if err := workflow.RecordProviderInputUnit(
				context.Background(),
				recordingID,
				ObservationJournalEntry{},
			); err != nil {
				return err
			}
			return armErr
		},
	}
	recording, err := workflow.Start(context.Background(), StartRecordingInput{
		ScopeID: "scope-1", AgentTargetID: "target-1",
	})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := workflow.Bind(context.Background(), BindRecordingInput{
		RecordingID: recording.ID,
		ScopeID:     "scope-1", AgentTargetID: "target-1",
		AgentSessionID: "root-1",
	}); !errors.Is(err, armErr) {
		t.Fatalf("Bind error = %v, want %v", err, armErr)
	}
	if workflow.captureAdmissionID != "" {
		t.Fatalf("capture admission remained %q", workflow.captureAdmissionID)
	}
	if _, ok := workflow.RecordingCursorSnapshotForCapture(recording.ID); ok {
		t.Fatal("failed recording remained admitted for capture")
	}
	if len(artifacts.journalEntries) != 1 {
		t.Fatalf("journal entries after Arm = %d, want 1", len(artifacts.journalEntries))
	}
	if err := workflow.RecordProviderInputUnit(
		context.Background(),
		recording.ID,
		ObservationJournalEntry{},
	); err != nil {
		t.Fatal(err)
	}
	if len(artifacts.journalEntries) != 1 {
		t.Fatalf("late callback wrote after Arm failure: %d entries", len(artifacts.journalEntries))
	}
}

func TestRecordingWorkflowSingleActiveCancelAndRecover(t *testing.T) {
	workflow, store, _, events := newWorkflowForTest("recording-1", "recording-2")
	first, err := workflow.Start(context.Background(), StartRecordingInput{
		ScopeID: "scope-1", AgentTargetID: "target-1",
	})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := workflow.Start(context.Background(), StartRecordingInput{
		ScopeID: "scope-1", AgentTargetID: "target-1",
	}); !errors.Is(err, ErrBusy) {
		t.Fatalf("concurrent Start error = %v", err)
	}
	if _, err := workflow.Cancel(context.Background(), first.ID); err != nil {
		t.Fatal(err)
	}
	if _, ok := store.recordings[first.ID]; ok {
		t.Fatalf("canceled recording %q was persisted", first.ID)
	}
	recordings, err := workflow.List(context.Background(), first.ScopeID)
	if err != nil {
		t.Fatal(err)
	}
	if len(recordings) != 0 {
		t.Fatalf("recordings after cancel = %#v", recordings)
	}
	second, err := workflow.Start(context.Background(), StartRecordingInput{
		ScopeID: "scope-1", AgentTargetID: "target-1",
	})
	if err != nil {
		t.Fatal(err)
	}
	restarted := &Workflow{
		Artifacts: workflow.Artifacts,
		Store:     store,
		Now:       workflow.Now,
	}
	if err := restarted.Recover(context.Background()); err != nil {
		t.Fatal(err)
	}
	got := store.recordings[second.ID]
	if got.Status != RecordingStatusIncomplete || got.ErrorCode != "daemon_restarted" {
		t.Fatalf("recovered recording = %#v", got)
	}
	if !slices.Contains(*events, "discard:"+second.ID) {
		t.Fatalf("events = %#v", *events)
	}
}

func TestReplayWorkflowPreparesOneCassetteWithoutExecutionState(t *testing.T) {
	workflow, store, artifacts, _ := newWorkflowForTest()
	workflow.NewID = nil
	workflow.Now = nil
	cassette := Cassette{
		ID:                 "cassette-1",
		RootAgentSessionID: "root-1",
		ArtifactKey:        "cassette-key",
	}
	store.cassettes[cassette.ID] = cassette
	artifacts.cassettes = map[string]Cassette{cassette.ID: cassette}
	prepared, err := workflow.PrepareReplayBatch(
		context.Background(),
		PrepareReplayBatchInput{
			CassetteIDs: []string{cassette.ID},
		},
	)
	if err != nil {
		t.Fatal(err)
	}
	request := prepared.Requests[0]
	if request.Cassette != cassette ||
		request.Artifact.Cassette != cassette ||
		request.Artifact.Layout.StorageKey != "cassette-key" {
		t.Fatalf("prepared request = %#v", request)
	}
}

func TestReplayWorkflowPreparesFixedBatch(t *testing.T) {
	workflow, store, artifacts, _ := newWorkflowForTest("unused-replay-id")
	first := Cassette{
		ID:                 "cassette-1",
		RootAgentSessionID: "root-1",
		ArtifactKey:        "cassette/1",
	}
	second := Cassette{
		ID:                 "cassette-2",
		RootAgentSessionID: "root-2",
		ArtifactKey:        "cassette/2",
	}
	store.cassettes[first.ID] = first
	store.cassettes[second.ID] = second
	artifacts.cassettes = map[string]Cassette{first.ID: first, second.ID: second}

	prepared, err := workflow.PrepareReplayBatch(
		context.Background(),
		PrepareReplayBatchInput{
			CassetteIDs: []string{"cassette-1", " cassette-2 "},
		},
	)
	if err != nil {
		t.Fatal(err)
	}
	if len(prepared.Requests) != 2 {
		t.Fatalf("prepared=%#v", prepared)
	}
	for index, request := range prepared.Requests {
		wantRoot := fmt.Sprintf("root-%d", index+1)
		if request.Cassette.RootAgentSessionID != wantRoot ||
			request.Artifact.Cassette.ID != request.Cassette.ID {
			t.Fatalf("request[%d] = %#v", index, request)
		}
	}
}

func TestReplayWorkflowBatchResolveFailureReturnsNoPreparedBatch(t *testing.T) {
	workflow, store, artifacts, _ := newWorkflowForTest("unused-replay-id")
	for index := 1; index <= 2; index++ {
		id := fmt.Sprintf("cassette-%d", index)
		cassette := Cassette{
			ID:                 id,
			RootAgentSessionID: fmt.Sprintf("root-%d", index),
			ArtifactKey:        "cassette/" + id,
		}
		store.cassettes[id] = cassette
		if artifacts.cassettes == nil {
			artifacts.cassettes = map[string]Cassette{}
		}
		artifacts.cassettes[id] = cassette
	}
	artifacts.resolveErrors = map[string]error{"cassette-2": errors.New("artifact missing")}

	_, err := workflow.PrepareReplayBatch(
		context.Background(),
		PrepareReplayBatchInput{
			CassetteIDs: []string{"cassette-1", "cassette-2"},
		},
	)
	if err == nil || !strings.Contains(err.Error(), "artifact missing") {
		t.Fatalf("PrepareReplayBatch() error = %v", err)
	}
}

func TestReplayWorkflowSingleCassetteResolveFailure(t *testing.T) {
	workflow, store, artifacts, _ := newWorkflowForTest("unused-replay-id")
	cassette := Cassette{
		ID:                 "cassette-1",
		RootAgentSessionID: "root-1",
	}
	store.cassettes[cassette.ID] = cassette
	artifacts.cassettes = map[string]Cassette{cassette.ID: cassette}
	artifacts.resolveErrors = map[string]error{cassette.ID: errors.New("artifact missing")}

	if _, err := workflow.PrepareReplayBatch(
		context.Background(),
		PrepareReplayBatchInput{
			CassetteIDs: []string{cassette.ID},
		},
	); err == nil || !strings.Contains(err.Error(), "artifact missing") {
		t.Fatalf("PrepareReplayBatch() error = %v", err)
	}
}

func TestReplayWorkflowRejectsDuplicateCassetteOrRoot(t *testing.T) {
	tests := []struct {
		name       string
		cassetteID string
		rootID     string
	}{
		{name: "cassette", cassetteID: "cassette-1", rootID: "root-2"},
		{name: "root", cassetteID: "cassette-2", rootID: "root-1"},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			workflow, store, artifacts, _ := newWorkflowForTest("unused-replay-id")
			first := Cassette{
				ID:                 "cassette-1",
				RootAgentSessionID: "root-1",
			}
			second := Cassette{
				ID:                 tt.cassetteID,
				RootAgentSessionID: tt.rootID,
			}
			store.cassettes[first.ID] = first
			store.cassettes[second.ID] = second
			artifacts.cassettes = map[string]Cassette{first.ID: first, second.ID: second}

			_, err := workflow.PrepareReplayBatch(
				context.Background(),
				PrepareReplayBatchInput{
					CassetteIDs: []string{"cassette-1", tt.cassetteID},
				},
			)
			if !errors.Is(err, ErrInvalidState) {
				t.Fatalf("PrepareReplayBatch() error = %v", err)
			}
		})
	}
}
