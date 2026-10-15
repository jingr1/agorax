package agentruntime

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"slices"
	"testing"
)


func TestCodexStartSetsPreparedExtraSkillRootsBeforeThread(t *testing.T) {
	t.Parallel()
	transport := newScriptedAppServerTransport()
	adapter := NewCodexAppServerAdapter(transport)
	root := filepath.Join(t.TempDir(), "session-skills")
	session := testAppServerSession()
	session.Provider = ProviderCodex
	session.Env = []string{agoraxAgentExtraSkillRootsEnv + "=" + mustEncodeExtraRoots(t, root)}
	if _, err := adapter.Start(context.Background(), session); err != nil {
		t.Fatalf("Start: %v", err)
	}
	params := appServerRequestParams(t, transport.conn, appServerMethodSkillsExtraRootsSet)
	if got := appServerStringSlice(params["extraRoots"]); !slices.Equal(got, []string{root}) {
		t.Fatalf("skills/extraRoots/set roots = %#v, want %#v", got, []string{root})
	}
	assertAppServerMethodOrder(t, appServerSentMethods(t, transport.conn),
		appServerMethodInitialize,
		appServerMethodInitialized,
		appServerMethodSkillsExtraRootsSet,
		appServerMethodThreadStart,
	)
}





func mustEncodeExtraRoots(t *testing.T, roots ...string) string {
	t.Helper()
	encoded, err := json.Marshal(roots)
	if err != nil {
		t.Fatal(err)
	}
	return string(encoded)
}

func appServerStringSlice(value any) []string {
	items, _ := value.([]any)
	result := make([]string, 0, len(items))
	for _, item := range items {
		result = append(result, asString(item))
	}
	return result
}

func writeTestSystemSkills(t *testing.T, root string, marker string) {
	t.Helper()
	if err := os.MkdirAll(filepath.Join(root, "skill-creator"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(root, systemSkillsMarkerFile), []byte(marker+"\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(
		filepath.Join(root, "skill-creator", "SKILL.md"),
		[]byte("---\nname: skill-creator\ndescription: test\n---\n"),
		0o644,
	); err != nil {
		t.Fatal(err)
	}
}

func appServerSentMethods(t *testing.T, conn *scriptedAppServerConnection) []string {
	t.Helper()
	conn.mu.Lock()
	sent := append([][]byte(nil), conn.sent...)
	conn.mu.Unlock()
	methods := make([]string, 0, len(sent))
	for _, data := range sent {
		for _, line := range acpScanLines(data) {
			var request struct {
				Method string `json:"method"`
			}
			if err := json.Unmarshal([]byte(line), &request); err != nil {
				t.Fatalf("unmarshal app-server request: %v", err)
			}
			if request.Method != "" {
				methods = append(methods, request.Method)
			}
		}
	}
	return methods
}

func assertAppServerMethodOrder(t *testing.T, methods []string, ordered ...string) {
	t.Helper()
	last := -1
	for _, method := range ordered {
		index := slices.Index(methods, method)
		if index < 0 {
			t.Fatalf("method %q missing from %#v", method, methods)
		}
		if index <= last {
			t.Fatalf("method order = %#v, want %#v", methods, ordered)
		}
		last = index
	}
}
