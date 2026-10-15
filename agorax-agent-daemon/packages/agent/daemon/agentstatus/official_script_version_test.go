package agentstatus

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"runtime"
	"strings"
	"testing"
	"time"

	"agorax.local/agent-daemon/packages/agent/daemon/providerregistry"
)

func TestOpenCodeInstallerCarriesNPMPackageName(t *testing.T) {
	descriptor, ok := providerregistry.Find(providerregistry.OpenCodeProviderID)
	if !ok {
		t.Fatal("opencode descriptor missing")
	}
	spec, err := installerSpecFromProviderDescriptor(descriptor.Status.Install)
	if err != nil {
		t.Fatalf("installerSpecFromProviderDescriptor: %v", err)
	}
	if spec.Kind != InstallerKindOfficialScript {
		t.Fatalf("kind = %q", spec.Kind)
	}
	if spec.PackageName != "@opencode/cli" {
		t.Fatalf("PackageName = %q, want @opencode/cli (npm pin for official script VERSION)", spec.PackageName)
	}
}

func TestOfficialScriptPinnedVersionFromNPM(t *testing.T) {
	registry := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if !strings.HasSuffix(r.URL.Path, "/@opencode/cli/latest") {
			http.NotFound(w, r)
			return
		}
		_ = json.NewEncoder(w).Encode(map[string]any{"version": "2.0.16"})
	}))
	t.Cleanup(registry.Close)

	service := Service{
		Environ: func() []string {
			return []string{agentNPMRegistryEnv + "=" + registry.URL}
		},
		HTTPClient:     registry.Client(),
		UpdateCacheTTL: time.Minute,
		Now:            func() time.Time { return time.Unix(1_700_000_000, 0) },
	}

	version, err := service.officialScriptPinnedVersion(context.Background(), InstallerSpec{
		Kind:        InstallerKindOfficialScript,
		PackageName: "@opencode/cli",
	})
	if err != nil {
		t.Fatalf("officialScriptPinnedVersion: %v", err)
	}
	if version != "2.0.16" {
		t.Fatalf("version = %q, want 2.0.16", version)
	}
}

func TestOfficialScriptPinnedVersionSkippedWithoutPackage(t *testing.T) {
	service := Service{}
	version, err := service.officialScriptPinnedVersion(context.Background(), InstallerSpec{
		Kind: InstallerKindOfficialScript,
	})
	if err != nil || version != "" {
		t.Fatalf("got (%q, %v), want empty", version, err)
	}
}

func TestRunOfficialScriptInstallerPinsVERSION(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("POSIX official-script VERSION pin test")
	}

	registry := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if strings.HasSuffix(r.URL.Path, "/@opencode/cli/latest") {
			_ = json.NewEncoder(w).Encode(map[string]any{"version": "9.9.9"})
			return
		}
		http.NotFound(w, r)
	}))
	t.Cleanup(registry.Close)

	scriptServer := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_, _ = w.Write([]byte(`#!/bin/sh
if [ -z "$VERSION" ]; then
  echo "VERSION missing" >&2
  exit 2
fi
echo "pinned=$VERSION"
exit 0
`))
	}))
	t.Cleanup(scriptServer.Close)

	service := Service{
		Environ: func() []string {
			return []string{
				"PATH=/usr/bin:/bin",
				agentNPMRegistryEnv + "=" + registry.URL,
			}
		},
		HTTPClient:     &http.Client{Timeout: 10 * time.Second},
		UpdateCacheTTL: time.Minute,
		Now:            func() time.Time { return time.Unix(1_700_000_000, 0) },
	}

	result, err := service.runOfficialScriptInstaller(context.Background(), "opencode", InstallerSpec{
		Kind:        InstallerKindOfficialScript,
		ScriptURL:   scriptServer.URL,
		ScriptShell: "sh",
		PackageName: "@opencode/cli",
	})
	if err != nil {
		t.Fatalf("runOfficialScriptInstaller: %v", err)
	}
	if result.ExitCode != 0 {
		t.Fatalf("exit=%d stderr=%q stdout=%q", result.ExitCode, result.Stderr, result.Stdout)
	}
	if !strings.Contains(result.Stdout, "pinned=9.9.9") {
		t.Fatalf("stdout=%q, want pinned VERSION", result.Stdout)
	}
}
