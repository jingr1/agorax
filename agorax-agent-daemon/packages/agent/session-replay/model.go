// Package sessionreplay owns provider-neutral Agent Session recording,
// Cassette, and replay preparation semantics.
package sessionreplay

import (
	"context"
	"errors"
	"strings"
	"time"
	"unicode/utf8"
)

var (
	ErrBusy              = errors.New("another agent session recording is active")
	ErrRecordingNotFound = errors.New("agent session recording not found")
	ErrCassetteNotFound  = errors.New("agent session cassette not found")
	ErrInvalidState      = errors.New("agent session replay state is invalid")
	ErrInvalidName       = errors.New("agent session recording name is invalid")
)

const MaxRecordingNameRunes = 120

type RecordingStatus string

const (
	RecordingStatusPreparing  RecordingStatus = "preparing"
	RecordingStatusReady      RecordingStatus = "ready"
	RecordingStatusRecording  RecordingStatus = "recording"
	RecordingStatusFinalizing RecordingStatus = "finalizing"
	RecordingStatusComplete   RecordingStatus = "complete"
	RecordingStatusFailed     RecordingStatus = "failed"
	RecordingStatusCanceled   RecordingStatus = "canceled"
	RecordingStatusIncomplete RecordingStatus = "incomplete"
)

type ScenarioMode string

const (
	ScenarioModeCreateSession   ScenarioMode = "create-session"
	ScenarioModeContinueSession ScenarioMode = "continue-session"
)

// Recording is a mutable capture task. A successful Recording produces exactly
// one Cassette whose replay payload is immutable and whose name is mutable.
type Recording struct {
	ID                  string              `json:"id"`
	Name                string              `json:"name"`
	CassetteID          string              `json:"cassetteId,omitempty"`
	ScopeID             string              `json:"scopeId"`
	AgentTargetID       string              `json:"agentTargetId"`
	ReplayPrerequisites ReplayPrerequisites `json:"replayPrerequisites"`
	Mode                ScenarioMode        `json:"mode"`
	RootAgentSessionID  string              `json:"rootAgentSessionId,omitempty"`
	Status              RecordingStatus     `json:"status"`
	ArtifactKey         string              `json:"-"`
	ErrorCode           string              `json:"errorCode,omitempty"`
	ErrorMessage        string              `json:"errorMessage,omitempty"`
	CreatedAtUnixMS     int64               `json:"createdAtUnixMs"`
	RecordingAtUnixMS   int64               `json:"recordingAtUnixMs,omitempty"`
	StoppedAtUnixMS     int64               `json:"stoppedAtUnixMs,omitempty"`
	UpdatedAtUnixMS     int64               `json:"updatedAtUnixMs"`
}

type StartRecordingInput struct {
	ScopeID             string
	AgentTargetID       string
	ReplayPrerequisites ReplayPrerequisites
	// AgentSessionID selects continue-session mode. Empty selects create-session.
	AgentSessionID string
}

// ReplayComposerDefaults are the resolved composer settings required to
// reproduce provider startup behavior. They are recorded in the portable
// Cassette instead of being inferred from a development scenario.
type ReplayComposerDefaults struct {
	Model            string `json:"model"`
	PermissionModeID string `json:"permissionModeId"`
	ReasoningEffort  string `json:"reasoningEffort"`
	Speed            string `json:"speed"`
}

// ReplayPrerequisites are immutable inputs that must be restored before a
// Cassette is replayed in an otherwise clean runtime.
type ReplayPrerequisites struct {
	ComposerDefaults ReplayComposerDefaults `json:"composerDefaults"`
}

func (p ReplayPrerequisites) normalized() ReplayPrerequisites {
	p.ComposerDefaults.Model = strings.TrimSpace(p.ComposerDefaults.Model)
	p.ComposerDefaults.PermissionModeID = strings.TrimSpace(
		p.ComposerDefaults.PermissionModeID,
	)
	p.ComposerDefaults.ReasoningEffort = strings.TrimSpace(
		p.ComposerDefaults.ReasoningEffort,
	)
	p.ComposerDefaults.Speed = strings.TrimSpace(p.ComposerDefaults.Speed)
	return p
}

func (p ReplayPrerequisites) valid() bool {
	p = p.normalized()
	return p.ComposerDefaults.Model != "" &&
		p.ComposerDefaults.PermissionModeID != "" &&
		p.ComposerDefaults.ReasoningEffort != "" &&
		p.ComposerDefaults.Speed != ""
}

type BindRecordingInput struct {
	RecordingID    string
	ScopeID        string
	AgentTargetID  string
	AgentSessionID string
}

type ReplayStatePhase string

const (
	ReplayStatePhaseInitial  ReplayStatePhase = "initial"
	ReplayStatePhaseExpected ReplayStatePhase = "expected"
)

// Cassette is the rebuildable catalog entry for one portable artifact. Its
// replay payload is immutable; Name and the manifest hash change together when
// renamed. ArtifactKey is adapter-owned and must not be serialized into the
// portable artifact or durable metadata.
type Cassette struct {
	ID                 string       `json:"id"`
	Name               string       `json:"name"`
	SourceRecordingID  string       `json:"sourceRecordingId"`
	AgentTargetID      string       `json:"agentTargetId"`
	RootAgentSessionID string       `json:"rootAgentSessionId"`
	Mode               ScenarioMode `json:"mode"`
	TotalBytes         int64        `json:"totalBytes"`
	ManifestSHA256     string       `json:"manifestSha256"`
	ArtifactKey        string       `json:"-"`
	CreatedAtUnixMS    int64        `json:"createdAtUnixMs"`
}

// MetadataStore persists operational metadata. Implementations may use a
// durable local database or an ephemeral CI store.
type MetadataStore interface {
	PutRecording(context.Context, Recording) error
	DeleteRecording(context.Context, string) error
	GetRecording(context.Context, string) (Recording, error)
	ListRecordings(context.Context, string) ([]Recording, error)
	PublishCassette(context.Context, Recording, Cassette) error
	UpdateCassette(context.Context, Recording, Cassette) error
	GetCassette(context.Context, string) (Cassette, error)
	ListCassettes(context.Context, string) ([]Cassette, error)
}

// ReplayStateStore captures a product-owned semantic state document for the
// selected root Session without knowing artifact storage or filesystem paths.
type ReplayStateStore interface {
	ResolveRootAgentSession(context.Context, string, string) (string, error)
	CaptureReplayState(context.Context, string, string) ([]byte, error)
	WaitAgentSessionGraphSettled(context.Context, string, string) error
}

// ProcessRecorder captures provider protocol traffic for one root SessionGraph.
// artifactKey is opaque to the core and resolved by the product adapter.
type ProcessRecorder interface {
	Arm(rootAgentSessionID, recordingID, artifactKey string) error
	Complete(rootAgentSessionID string) error
	Cancel(rootAgentSessionID string) error
}

type ArtifactLayout struct {
	StorageKey        string
	ProviderTapeKey   string
	CheckpointPlanKey string
	InitialStateKey   string
	ExpectedStateKey  string
}

type Artifact struct {
	Cassette Cassette
	Layout   ArtifactLayout
}

// ArtifactStore owns every required file operation for Recording candidates
// and Cassettes, including cassette v7 checkpoint and observation persistence.
// Keys are opaque to the application workflow.
type ArtifactStore interface {
	Prepare(context.Context, Recording) (ArtifactLayout, error)
	LocateRecording(context.Context, Recording) (ArtifactLayout, error)
	AppendActivityEvent(context.Context, Recording, ActivityEvent) error
	AppendObservationJournalEntry(context.Context, Recording, ObservationJournalEntry) error
	WriteCheckpointPlan(context.Context, Recording, CheckpointPlan) error
	WriteReplayState(context.Context, Recording, ReplayStatePhase, []byte) error
	Publish(context.Context, Recording, string, uint64) (Artifact, error)
	RollbackPublish(context.Context, Artifact, Recording) error
	Resolve(context.Context, Cassette) (Artifact, error)
	RenameCassette(context.Context, Cassette, string) (Artifact, error)
	DiscardRecording(context.Context, string) error
	DiscardCassette(context.Context, string) error
}

type RecordingCursorSnapshot struct {
	Recording             Recording
	ActivityEventSequence uint64
}

type ReplayRequest struct {
	Cassette Cassette
	Artifact Artifact
}

type PrepareReplayBatchInput struct {
	CassetteIDs []string
}

type ReplayBatchRequest struct {
	Requests []ReplayRequest
}

type IDGenerator func() string
type Clock func() time.Time

func DefaultRecordingName(createdAt time.Time) string {
	return createdAt.UTC().Format("2006-01-02T15:04:05.000Z")
}

func NormalizeRecordingName(name string) (string, error) {
	name = strings.TrimSpace(name)
	if name == "" || utf8.RuneCountInString(name) > MaxRecordingNameRunes {
		return "", ErrInvalidName
	}
	return name, nil
}
