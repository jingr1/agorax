package agentruntime

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"

	replay "agorax.local/agent-daemon/packages/agent/session-replay"
)

// AuditProjectedProcessCassetteFrames verifies that a persisted Provider tape
// contains only the structural values allowed after recording projection.
func AuditProjectedProcessCassetteFrames(path string) error {
	manifestRaw, err := os.ReadFile(filepath.Join(
		filepath.Dir(path),
		processCassetteManifestName,
	))
	if err != nil {
		return fmt.Errorf("read projected process cassette manifest: %w", err)
	}
	var manifest ProcessCassetteManifest
	if err := json.Unmarshal(manifestRaw, &manifest); err != nil {
		return fmt.Errorf("decode projected process cassette manifest: %w", err)
	}
	file, err := os.Open(path)
	if err != nil {
		return fmt.Errorf("open projected process cassette frames: %w", err)
	}
	defer file.Close()
	return replay.AuditProjectedProcessCassetteFrames(
		file,
		manifest.Connections,
	)
}
