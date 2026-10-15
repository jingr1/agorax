package sessionreplay

import (
	"crypto/sha256"
	"fmt"
	"strings"
	"testing"
)

func cassetteDigest(value string) string {
	return fmt.Sprintf("%x", sha256.Sum256([]byte(value)))
}

func validCassetteFiles(mode ScenarioMode) []CassetteFile {
	var result []CassetteFile
	for _, file := range requiredCassetteFiles(mode) {
		result = append(result, CassetteFile{
			Path: file, SizeBytes: 1, SHA256: cassetteDigest(file),
		})
	}
	return result
}

func validReplayPrerequisites() ReplayPrerequisites {
	return ReplayPrerequisites{ComposerDefaults: ReplayComposerDefaults{
		Model:            "gpt-5.4",
		PermissionModeID: "default",
		ReasoningEffort:  "medium",
		Speed:            "normal",
	}}
}

func TestBuildAndValidateCassetteManifest(t *testing.T) {
	manifest, err := BuildCassetteManifest(CassetteManifestInput{
		ID: "cassette-1", SourceRecordingID: "recording-1",
		Name:                "2026-07-28T10:00:00.000Z",
		StateFormat:         "test.replay-state.v1",
		AgentTargetID:       "target-1",
		ReplayPrerequisites: validReplayPrerequisites(),
		RootSessionID:       "session-1", Mode: ScenarioModeCreateSession,
		CreatedAtUnixMS: 1,
	}, validCassetteFiles(ScenarioModeCreateSession), BlobManifest{
		SchemaVersion: BlobManifestSchemaVersion,
		Blobs:         []BlobManifestEntry{},
	})
	if err != nil {
		t.Fatal(err)
	}
	if manifest.TotalBytes != int64(len(requiredCassetteFiles(ScenarioModeCreateSession))) {
		t.Fatalf("manifest = %#v", manifest)
	}
	if err := ValidateCassetteIntegrity(manifest, manifest.Files); err != nil {
		t.Fatal(err)
	}
}

func TestCassetteSchemaV7IncludesReplayPrerequisites(t *testing.T) {
	if CassetteSchemaVersion != 7 {
		t.Fatalf("cassette schema version = %d, want 7", CassetteSchemaVersion)
	}
	roles, err := AllowedCassetteFiles(BlobManifest{
		SchemaVersion: BlobManifestSchemaVersion,
	})
	if err != nil {
		t.Fatal(err)
	}
	for _, removed := range []string{
		"scenario.json",
		"environment.json",
		"checkpoints.jsonl",
		"seed/state.jsonl",
		"expected/state.jsonl",
	} {
		if _, ok := roles[removed]; ok {
			t.Fatalf("removed v4 file %q remains allowed", removed)
		}
	}
	for _, current := range []string{
		ActivityEventsFile,
		CheckpointPlanFile,
		InitialStateFile,
		ProviderManifestFile,
		ProviderFramesFile,
		ExpectedStateFile,
		BlobManifestFile,
	} {
		if _, ok := roles[current]; !ok {
			t.Fatalf("v5 file %q is not allowed", current)
		}
	}
}

func TestCassetteSemanticStateRequirementsFollowMode(t *testing.T) {
	base := CassetteManifestInput{
		ID: "cassette-1", SourceRecordingID: "recording-1",
		Name:                "2026-07-28T10:00:00.000Z",
		StateFormat:         "test.replay-state.v1",
		ReplayPrerequisites: validReplayPrerequisites(),
		RootSessionID:       "session-1", CreatedAtUnixMS: 1,
	}
	blobs := BlobManifest{SchemaVersion: BlobManifestSchemaVersion}
	base.Mode = ScenarioModeContinueSession
	files := validCassetteFiles(base.Mode)
	for index, file := range files {
		if file.Path == InitialStateFile {
			files = append(files[:index], files[index+1:]...)
			break
		}
	}
	if _, err := BuildCassetteManifest(base, files, blobs); err == nil ||
		!strings.Contains(err.Error(), InitialStateFile) {
		t.Fatalf("missing initial state error = %v", err)
	}
	base.Mode = ScenarioModeCreateSession
	files = validCassetteFiles(base.Mode)
	files = append(files, CassetteFile{
		Path: InitialStateFile, SizeBytes: 1, SHA256: cassetteDigest(InitialStateFile),
	})
	if _, err := BuildCassetteManifest(base, files, blobs); err == nil ||
		!strings.Contains(err.Error(), "must not contain") {
		t.Fatalf("forbidden initial state error = %v", err)
	}
}

func TestCassetteManifestRejectsUnknownAndMissingFiles(t *testing.T) {
	input := CassetteManifestInput{
		ID: "cassette-1", SourceRecordingID: "recording-1",
		Name:                "2026-07-28T10:00:00.000Z",
		StateFormat:         "test.replay-state.v1",
		ReplayPrerequisites: validReplayPrerequisites(),
		RootSessionID:       "session-1", Mode: ScenarioModeCreateSession, CreatedAtUnixMS: 1,
	}
	files := validCassetteFiles(ScenarioModeCreateSession)
	files = append(files, CassetteFile{
		Path: "desktop.log", SizeBytes: 1, SHA256: cassetteDigest("log"),
	})
	if _, err := BuildCassetteManifest(input, files, BlobManifest{
		SchemaVersion: BlobManifestSchemaVersion,
	}); err == nil || !strings.Contains(err.Error(), "unrelated file") {
		t.Fatalf("unknown file error = %v", err)
	}
	files = validCassetteFiles(ScenarioModeCreateSession)[1:]
	if _, err := BuildCassetteManifest(input, files, BlobManifest{
		SchemaVersion: BlobManifestSchemaVersion,
	}); err == nil || !strings.Contains(err.Error(), "missing required file") {
		t.Fatalf("missing file error = %v", err)
	}
}

func TestCassetteIntegrityRejectsChangedHash(t *testing.T) {
	manifest, err := BuildCassetteManifest(CassetteManifestInput{
		ID: "cassette-1", SourceRecordingID: "recording-1",
		Name:                "2026-07-28T10:00:00.000Z",
		StateFormat:         "test.replay-state.v1",
		ReplayPrerequisites: validReplayPrerequisites(),
		RootSessionID:       "session-1", CreatedAtUnixMS: 1,
		Mode: ScenarioModeCreateSession,
	}, validCassetteFiles(ScenarioModeCreateSession), BlobManifest{
		SchemaVersion: BlobManifestSchemaVersion,
	})
	if err != nil {
		t.Fatal(err)
	}
	actual := append([]CassetteFile(nil), manifest.Files...)
	actual[0].SHA256 = cassetteDigest("changed")
	if err := ValidateCassetteIntegrity(manifest, actual); err == nil {
		t.Fatal("changed cassette hash was accepted")
	}
}

func TestCassetteManifestPolicyRejectsTamperedAllowlist(t *testing.T) {
	manifest, err := BuildCassetteManifest(CassetteManifestInput{
		ID: "cassette-1", SourceRecordingID: "recording-1",
		Name:                "2026-07-28T10:00:00.000Z",
		StateFormat:         "test.replay-state.v1",
		ReplayPrerequisites: validReplayPrerequisites(),
		RootSessionID:       "session-1", CreatedAtUnixMS: 1,
		Mode: ScenarioModeCreateSession,
	}, validCassetteFiles(ScenarioModeCreateSession), BlobManifest{
		SchemaVersion: BlobManifestSchemaVersion,
	})
	if err != nil {
		t.Fatal(err)
	}
	manifest.Files = append(manifest.Files, CassetteFile{
		Path: "agoraxd.db", Role: "database", SizeBytes: 1, SHA256: cassetteDigest("db"),
	})
	manifest.TotalBytes++
	if err := ValidateCassetteManifestPolicy(manifest, BlobManifest{
		SchemaVersion: BlobManifestSchemaVersion,
	}); err == nil {
		t.Fatal("tampered cassette allowlist was accepted")
	}
}

func TestCassetteBlobVocabularyControlsAllowlist(t *testing.T) {
	digest := cassetteDigest("blob")
	roles, err := AllowedCassetteFiles(BlobManifest{
		SchemaVersion: BlobManifestSchemaVersion,
		Blobs: []BlobManifestEntry{{
			Kind: BlobKindAgentPromptAttachment, SHA256: digest, SizeBytes: 4,
			AgentSessionID: "session-1", AttachmentID: "attachment-1",
			MimeType: "image/png",
		}},
	})
	if err != nil {
		t.Fatal(err)
	}
	if roles["blobs/sha256/"+digest] != "referenced-blob" {
		t.Fatalf("roles = %#v", roles)
	}
}

func TestCassetteGeneratedImageBlobVocabularyControlsAllowlist(t *testing.T) {
	digest := cassetteDigest("generated-image")
	roles, err := AllowedCassetteFiles(BlobManifest{
		SchemaVersion: BlobManifestSchemaVersion,
		Blobs: []BlobManifestEntry{{
			Kind: BlobKindAgentGeneratedImage, SHA256: digest, SizeBytes: 4,
			AgentSessionID: "session-1",
			RelativePath:   "generated_images/call-1/image.png",
			MimeType:       "image/png",
		}},
	})
	if err != nil {
		t.Fatal(err)
	}
	if roles["blobs/sha256/"+digest] != "referenced-blob" {
		t.Fatalf("roles = %#v", roles)
	}
}
