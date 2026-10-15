package agentstatus

import (
	"os"
	"path/filepath"
	"testing"
)

func TestManagedNPMPrefixWritable(t *testing.T) {
	t.Parallel()
	writable := t.TempDir()
	if !managedNPMPrefixWritable(writable) {
		t.Fatalf("expected temp dir writable: %s", writable)
	}
	if managedNPMPrefixWritable(filepath.Join(writable, "missing")) {
		t.Fatal("missing dir must not be writable")
	}
	// /usr is typically not writable for a normal user; skip if this process can write it.
	if _, err := os.Stat("/usr"); err == nil && !managedNPMPrefixWritable("/usr") {
		prefix, ok := managedNPMRepairInstallPrefix("/usr/bin/does-not-matter", "@openai/codex")
		if ok || prefix != "" {
			t.Fatalf("unwritable system prefix must be rejected, got %q ok=%v", prefix, ok)
		}
	}
}
