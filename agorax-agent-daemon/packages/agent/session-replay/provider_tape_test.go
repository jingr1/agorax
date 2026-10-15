package sessionreplay

import (
	"encoding/base64"
	"encoding/json"
	"strings"
	"testing"
)

func TestAuditProjectedProcessCassetteFrames(t *testing.T) {
	t.Run("accepts portable protocol values", func(t *testing.T) {
		frames := projectedProviderFrame(
			t,
			map[string]any{"method": "turn/completed", "cwd": "${SESSION_CWD:root:1}"},
		)
		if err := AuditProjectedProcessCassetteFrames(strings.NewReader(frames), codexTapeConnections()); err != nil {
			t.Fatal(err)
		}
	})

	t.Run("rejects credentials", func(t *testing.T) {
		frames := projectedProviderFrame(
			t,
			map[string]any{"method": "account/login/start"},
		)
		err := AuditProjectedProcessCassetteFrames(strings.NewReader(frames), codexTapeConnections())
		if err == nil || !strings.Contains(err.Error(), "credential-bearing method") {
			t.Fatalf("AuditProjectedProcessCassetteFrames error = %v", err)
		}
	})

	t.Run("rejects absolute paths", func(t *testing.T) {
		frames := projectedProviderFrame(
			t,
			map[string]any{"method": "turn/completed", "cwd": "/Users/person/project"},
		)
		err := AuditProjectedProcessCassetteFrames(strings.NewReader(frames), codexTapeConnections())
		if err == nil || !strings.Contains(err.Error(), "non-portable path") {
			t.Fatalf("AuditProjectedProcessCassetteFrames error = %v", err)
		}
	})

	t.Run("rejects absolute generated image paths", func(t *testing.T) {
		frames := projectedProviderFrame(
			t,
			map[string]any{
				"method":    "item/completed",
				"savedPath": "/Users/person/.codex/generated_images/image.png",
			},
		)
		err := AuditProjectedProcessCassetteFrames(strings.NewReader(frames), codexTapeConnections())
		if err == nil || !strings.Contains(err.Error(), "non-portable path") {
			t.Fatalf("AuditProjectedProcessCassetteFrames error = %v", err)
		}
	})
}

func TestAuditProjectedProcessCassetteFramesRejectsUnregisteredProvider(t *testing.T) {
	frames := projectedProviderFrame(t, map[string]any{"method": "initialize"})
	err := AuditProjectedProcessCassetteFrames(
		strings.NewReader(frames),
		[]ProcessCassetteConnectionRecord{{
			ConnectionID: "connection-1",
			Provider:     "cursor",
		}},
	)
	if err == nil || !strings.Contains(err.Error(), "no replay adapter") {
		t.Fatalf("AuditProjectedProcessCassetteFrames error = %v", err)
	}
}

func codexTapeConnections() []ProcessCassetteConnectionRecord {
	return []ProcessCassetteConnectionRecord{{
		ConnectionID: "connection-1",
		Provider:     "codex",
	}}
}

func projectedProviderFrame(t *testing.T, value any) string {
	t.Helper()
	protocol, err := json.Marshal(value)
	if err != nil {
		t.Fatal(err)
	}
	protocol = append(protocol, '\n')
	frame, err := json.Marshal(ProcessCassetteChunk{
		ConnectionID: "connection-1",
		ChunkSeq:     1,
		GlobalSeq:    1,
		Kind:         "stdout",
		Data:         base64.StdEncoding.EncodeToString(protocol),
	})
	if err != nil {
		t.Fatal(err)
	}
	return string(append(frame, '\n'))
}
