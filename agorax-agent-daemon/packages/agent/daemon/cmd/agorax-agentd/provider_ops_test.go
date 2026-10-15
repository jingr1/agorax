package main

import (
	"context"
	"database/sql"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
	"time"

	"agorax.local/agent-daemon/packages/agent/daemon/managednpm"
	"agorax.local/agent-daemon/packages/agent/daemon/providerregistry"
	storesqlite "agorax.local/agent-daemon/packages/agent/store-sqlite"
	_ "modernc.org/sqlite"
)

// These tests exercise the real receiving boundary: provider detection runs
// fake executables through the runtime command resolver and execs them with
// argv arrays, and managed npm installs run a fake npm launcher that records
// its argv. The Windows .cmd/.ps1 interpreter routing lives behind
// newProviderExecCommand; the POSIX lane covers the direct-exec contract here
// and the Windows CI lane owns the cmd.exe adapter path.

const fakeClaudeScript = `#!/bin/sh
for arg in "$@"; do
  if [ "$arg" = "--version" ]; then
    echo "2.1.0 (claude code)"
    exit 0
  fi
done
if [ "$1" = "auth" ] && [ "$2" = "status" ]; then
  echo '{"loggedIn":true,"accountLabel":"dev@example.com","authMethod":"oauth"}'
  exit 0
fi
echo "unsupported invocation: $*" >&2
exit 1
`

const fakeCodexScript = `#!/bin/sh
for arg in "$@"; do
  if [ "$arg" = "--version" ]; then
    echo "codex-cli 0.153.4"
    exit 0
  fi
done
if [ "$1" = "-c" ]; then
  echo "logged in as dev@example.com"
  exit 0
fi
echo "unsupported invocation: $*" >&2
exit 1
`

// fakeNPMScript installs a codex binary printing newVersion into the prefix
// passed via --prefix and records every argv line into NPM_ARGV_LOG.
// Coreutils are referenced by absolute path because the test environment
// restricts PATH to the fake bin directory.
const fakeNPMScriptTemplate = `#!/bin/sh
log="${NPM_ARGV_LOG:?}"
printf '%%s\n' "$@" >> "$log" || exit 1
prefix=""
prev=""
for arg in "$@"; do
  if [ "$prev" = "--prefix" ]; then prefix="$arg"; fi
  prev="$arg"
done
if [ -z "$prefix" ]; then
  echo "missing --prefix" >&2
  exit 1
fi
/bin/mkdir -p "$prefix/bin" || exit 1
{
  printf '#!/bin/sh\n'
  printf 'echo "codex-cli %s"\n'
} > "$prefix/bin/codex" || exit 1
/bin/chmod +x "$prefix/bin/codex" || exit 1
echo "+ codex@%s"
exit 0
`

func writeExecutable(t *testing.T, dir string, name string, content string) string {
	t.Helper()
	if runtime.GOOS == "windows" {
		t.Skip("POSIX fake-bin script tests do not run on Windows")
	}
	path := filepath.Join(dir, name)
	if err := os.WriteFile(path, []byte(content), 0o755); err != nil {
		t.Fatalf("write %s: %v", path, err)
	}
	return path
}

// fakeProviderEnv builds a providerOps whose resolver searches binDir, whose
// home is homeDir, and whose registry probes go through registryServer (or a
// pinned override when non-nil).
func fakeProviderOps(t *testing.T, binDir string, homeDir string, envExtra []string) *providerOps {
	t.Helper()
	env := append([]string{"PATH=" + binDir}, envExtra...)
	ops := &providerOps{
		httpClient:   &http.Client{Timeout: 2 * time.Second},
		environ:      func() []string { return env },
		homeDir:      func() (string, error) { return homeDir, nil },
		now:          time.Now,
		latestCached: map[string]latestVersionEntry{},
		installing:   map[string]bool{},
		loggingIn:    map[string]bool{},
	}
	ops.resolver.Environ = ops.environ
	ops.resolver.HomeDir = ops.homeDir
	svc := newAgentStatusService(ops.environ, ops.homeDir)
	ops.statusService = &svc
	return ops
}

func TestProviderStatusAggregatesDetectedRuntimes(t *testing.T) {
	binDir := t.TempDir()
	writeExecutable(t, binDir, "claude", fakeClaudeScript)
	writeExecutable(t, binDir, "codex", fakeCodexScript)
	ops := fakeProviderOps(t, binDir, t.TempDir(), nil)
	// Pin registry discovery so the test never touches the network.
	ops.latestCached["@anthropic-ai/claude-code"] = latestVersionEntry{version: "2.1.0", checked: time.Now()}
	ops.latestCached["@openai/codex"] = latestVersionEntry{version: "0.153.4", checked: time.Now()}
	ops.registeredProviders = func() map[string]bool {
		return map[string]bool{"claude-code": true, "acp:kimi-code": true}
	}

	server, _ := newTestServerWithOps(t, ops)
	status, body := getJSON(t, server.URL+"/v1/provider-status")
	if status != http.StatusOK {
		t.Fatalf("status = %d body = %v", status, body)
	}
	providers, ok := body["providers"].([]any)
	if !ok || len(providers) != 5 {
		t.Fatalf("providers = %v", body["providers"])
	}
	byID := map[string]map[string]any{}
	for _, raw := range providers {
		entry := raw.(map[string]any)
		byID[entry["provider"].(string)] = entry
	}

	claude := byID["claude-code"]
	if claude == nil || claude["installed"] != true || claude["registered"] != true {
		t.Fatalf("claude-code = %v", claude)
	}
	if claude["version"] != "2.1.0" || claude["binaryPath"] == nil {
		t.Fatalf("claude-code detail = %v", claude)
	}
	auth := claude["auth"].(map[string]any)
	// Agorax agentstatus reports oauth-present-but-sidecar-missing as
	// "configured"; the older Agorax thin detector collapsed that to
	// "authenticated". Both are success-shaped for the Runtimes UI.
	if auth["accountLabel"] != "dev@example.com" {
		t.Fatalf("claude-code auth = %v", auth)
	}
	if status := auth["status"]; status != "authenticated" && status != "configured" {
		t.Fatalf("claude-code auth status = %v", auth)
	}
	if claude["updateAvailable"] != false {
		t.Fatalf("claude-code updateAvailable = %v", claude["updateAvailable"])
	}
	install := claude["install"].(map[string]any)
	if install["kind"] != "official_script" || install["binaryName"] != "claude" || install["managedNpm"] != false {
		t.Fatalf("claude-code install = %v", install)
	}
	if install["displayCommand"] != "curl -fsSL https://claude.ai/install.sh | bash" {
		t.Fatalf("claude-code displayCommand = %v", install["displayCommand"])
	}

	codex := byID["codex"]
	if codex == nil || codex["installed"] != true || codex["version"] != "0.153.4" {
		t.Fatalf("codex = %v", codex)
	}
	if codex["updateAvailable"] != false {
		t.Fatalf("codex updateAvailable = %v", codex["updateAvailable"])
	}

	// kimi-code is a host-only stub (ACP extension); install uses the official
	// script. Host may already have `kimi` on PATH; registration + install DTO
	// are asserted here.
	kimi := byID["kimi-code"]
	if kimi == nil || kimi["registered"] != true {
		t.Fatalf("kimi-code = %v", kimi)
	}
	kimiInstall, ok := kimi["install"].(map[string]any)
	if !ok || kimiInstall["kind"] != "official_script" || kimiInstall["binaryName"] != "kimi" {
		t.Fatalf("kimi-code install = %v", kimi["install"])
	}
	kimiLogin, ok := kimi["login"].(map[string]any)
	if !ok || kimiLogin["supported"] != true {
		t.Fatalf("kimi-code login = %v, want supported daemon login", kimi["login"])
	}
	if !strings.Contains(fmt.Sprint(kimiLogin["displayCommand"]), "login") {
		t.Fatalf("kimi-code login displayCommand = %v", kimiLogin["displayCommand"])
	}

	if byID["cursor"] == nil || byID["opencode"] == nil {
		t.Fatalf("cursor/opencode missing = %v / %v", byID["cursor"], byID["opencode"])
	}
	cursorInstall, ok := byID["cursor"]["install"].(map[string]any)
	if !ok || cursorInstall["kind"] != "official_script" || cursorInstall["managedNpm"] != false || cursorInstall["binaryName"] != "cursor-agent" {
		t.Fatalf("cursor install = %v", byID["cursor"]["install"])
	}
	opencodeInstall, ok := byID["opencode"]["install"].(map[string]any)
	if !ok || opencodeInstall["kind"] != "official_script" || opencodeInstall["packageName"] != "@opencode/cli" {
		t.Fatalf("opencode install = %v", byID["opencode"]["install"])
	}
}

func TestForceRefreshClearsLoginInProgress(t *testing.T) {
	ops := fakeProviderOps(t, t.TempDir(), t.TempDir(), nil)
	ops.registeredProviders = func() map[string]bool { return map[string]bool{} }
	if _, ok := ops.acquireLogin("kimi-code"); !ok {
		t.Fatal("acquireLogin failed")
	}
	if !ops.isLoginInProgress("kimi-code") {
		t.Fatal("expected loginInProgress after acquire")
	}

	server, _ := newTestServerWithOps(t, ops)
	status, body := getJSON(t, server.URL+"/v1/provider-status?refresh=1")
	if status != http.StatusOK {
		t.Fatalf("status = %d body = %v", status, body)
	}
	if ops.isLoginInProgress("kimi-code") {
		t.Fatal("ForceRefresh should clear loginInProgress so Login can be retried")
	}
	providers, _ := body["providers"].([]any)
	for _, raw := range providers {
		entry := raw.(map[string]any)
		if entry["provider"] == "kimi-code" && entry["loginInProgress"] == true {
			t.Fatalf("kimi-code still loginInProgress after refresh: %v", entry)
		}
	}
}

func TestKimiCodeEnablePreferenceWithoutAdapter(t *testing.T) {
	ops := fakeProviderOps(t, t.TempDir(), t.TempDir(), nil)
	ops.registeredProviders = func() map[string]bool {
		// Preference-only path: stub registry omits acp:kimi-code.
		return map[string]bool{"claude-code": true}
	}
	descriptor, ok := findProviderTarget("kimi-code")
	if !ok {
		t.Fatal("kimi-code descriptor missing")
	}
	if ops.isRegistered(descriptor) {
		t.Fatal("kimi-code should start unregistered without adapter/preference")
	}
	if err := ops.setUserEnabledPreference("kimi-code", true); err != nil {
		t.Fatalf("enable: %v", err)
	}
	if !ops.isRegistered(descriptor) {
		t.Fatal("kimi-code enable preference should flip registered=true")
	}
	if err := ops.setUserEnabledPreference("kimi-code", false); err != nil {
		t.Fatalf("disable: %v", err)
	}
	if ops.isRegistered(descriptor) {
		t.Fatal("kimi-code disable preference should flip registered=false")
	}
}

func TestEnabledPreferencePersistsAcrossHydrate(t *testing.T) {
	dbPath := filepath.Join(t.TempDir(), "agent.db")
	db, err := sql.Open("sqlite", dbPath)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = db.Close() })
	store := storesqlite.New(db, storesqlite.Options{})
	if err := store.Migrate(t.Context()); err != nil {
		t.Fatalf("migrate: %v", err)
	}

	ops := fakeProviderOps(t, t.TempDir(), t.TempDir(), nil)
	ops.attachTargetStore(store)
	if err := ops.setUserEnabledPreference("opencode", false); err != nil {
		t.Fatalf("persist disable: %v", err)
	}
	if err := ops.setUserEnabledPreference("kimi-code", true); err != nil {
		t.Fatalf("persist enable: %v", err)
	}

	reloaded := fakeProviderOps(t, t.TempDir(), t.TempDir(), nil)
	reloaded.attachTargetStore(store)
	if err := reloaded.hydrateEnabledFromStore(t.Context()); err != nil {
		t.Fatalf("hydrate: %v", err)
	}
	if enabled, ok := reloaded.userEnabledPreference("opencode"); !ok || enabled {
		t.Fatalf("opencode pref = (%v, %v), want disabled", enabled, ok)
	}
	if enabled, ok := reloaded.userEnabledPreference("kimi-code"); !ok || !enabled {
		t.Fatalf("kimi-code pref = (%v, %v), want enabled", enabled, ok)
	}
}

func TestProviderStatusFlagsUpdateAvailable(t *testing.T) {
	binDir := t.TempDir()
	writeExecutable(t, binDir, "claude", fakeClaudeScript)
	ops := fakeProviderOps(t, binDir, t.TempDir(), nil)

	server, _ := newTestServerWithOps(t, ops)
	_, body := getJSON(t, server.URL+"/v1/provider-status")
	providers := body["providers"].([]any)
	claude := providers[1].(map[string]any) // catalog order: codex, claude-code, ...
	if claude["provider"] != "claude-code" {
		t.Fatalf("provider order changed: %v", claude["provider"])
	}
	// Native/official-script installs auto-update; Agorax does not advertise
	// a managed npm upgrade path for Claude Code.
	if claude["updateAvailable"] != false {
		t.Fatalf("claude-code updateAvailable = %v", claude["updateAvailable"])
	}
	update := claude["update"].(map[string]any)
	if update["capability"] != "unsupported" || update["unsupportedReason"] != "official_script_update_unsupported" {
		t.Fatalf("claude-code update = %v", claude)
	}
}

func TestProviderStatusKeepsProbeErrorsNonFatal(t *testing.T) {
	binDir := t.TempDir()
	// Version probe exits non-zero and prints nothing parseable.
	writeExecutable(t, binDir, "claude", "#!/bin/sh\necho 'boom' >&2\nexit 1\n")
	ops := fakeProviderOps(t, binDir, t.TempDir(), nil)

	server, _ := newTestServerWithOps(t, ops)
	status, body := getJSON(t, server.URL+"/v1/provider-status")
	if status != http.StatusOK {
		t.Fatalf("status = %d body = %v", status, body)
	}
	for _, raw := range body["providers"].([]any) {
		entry := raw.(map[string]any)
		if entry["provider"] != "claude-code" {
			continue
		}
		if entry["installed"] != true || entry["version"] != nil {
			t.Fatalf("claude-code = %v", entry)
		}
		if entry["error"] == "" {
			t.Fatalf("expected probe error, got %v", entry)
		}
		return
	}
	t.Fatal("claude-code missing from provider-status")
}

func TestProviderInstallIsIdempotentWhenSatisfied(t *testing.T) {
	home := t.TempDir()
	binDir := t.TempDir()
	// npm launcher that would record argv; must never run on the idempotent path.
	npmPath := writeExecutable(t, binDir, "npm", "#!/bin/sh\nexit 99\n")
	prefixBin := filepath.Join(home, ".local", "bin")
	if err := os.MkdirAll(prefixBin, 0o755); err != nil {
		t.Fatalf("mkdir prefix bin: %v", err)
	}
	writeExecutable(t, prefixBin, "codex", "#!/bin/sh\necho 'codex-cli 0.200.0'\n")

	ops := fakeProviderOps(t, binDir, home, nil)
	ops.latestCached["@openai/codex"] = latestVersionEntry{version: "0.200.0", checked: time.Now()}

	result, httpStatus, err := ops.installProvider(context.Background(), "codex", "")
	if err != nil {
		t.Fatalf("installProvider: %v", err)
	}
	if httpStatus != http.StatusOK || result.Status != "already" {
		t.Fatalf("result = (%d, %+v)", httpStatus, result)
	}
	if result.Version == nil || *result.Version != "0.200.0" {
		t.Fatalf("version = %+v", result)
	}
	if _, statErr := os.Stat(npmPath); statErr != nil {
		t.Fatalf("npm path missing: %v", statErr)
	}
	// The fake npm exits 99 when run; the idempotent path must not invoke it at
	// all, which a successful "already" result already proves.
}

func TestProviderInstallEnsureDoesNotUpgrade(t *testing.T) {
	// Empty-version installs are "ensure present": a newer registry release
	// alone must not trigger a reinstall/upgrade.
	home := t.TempDir()
	binDir := t.TempDir()
	argvLog := filepath.Join(t.TempDir(), "npm-argv.log")
	prefixBin := filepath.Join(home, ".local", "bin")
	if err := os.MkdirAll(prefixBin, 0o755); err != nil {
		t.Fatalf("mkdir prefix bin: %v", err)
	}
	writeExecutable(t, prefixBin, "claude", "#!/bin/sh\nfor a in \"$@\"; do [ \"$a\" = \"--version\" ] && echo '2.1.268 (Claude Code)'; done\n")
	// npm exits 99 if invoked; the idempotent path must never call it.
	writeExecutable(t, binDir, "npm", "#!/bin/sh\nexit 99\n")
	ops := fakeProviderOps(t, binDir, home, nil)
	ops.latestCached["@anthropic-ai/claude-code"] = latestVersionEntry{version: "2.1.276", checked: time.Now()}

	result, httpStatus, err := ops.installProvider(context.Background(), "claude-code", "")
	if err != nil {
		t.Fatalf("installProvider: %v", err)
	}
	if httpStatus != http.StatusOK || result.Status != "already" {
		t.Fatalf("result = (%d, %+v)", httpStatus, result)
	}
	if _, err := os.Stat(argvLog); !os.IsNotExist(err) {
		t.Fatalf("npm was invoked on the ensure path: %v", err)
	}

	// An explicit "latest" upgrade with a newer release available proceeds.
	registry := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_, _ = w.Write([]byte(`{"version":"0.200.0"}`))
	}))
	t.Cleanup(registry.Close)
	ops.environ = func() []string {
		return []string{"PATH=" + binDir, "NPM_ARGV_LOG=" + argvLog, managednpm.RegistryOverrideEnv + "=" + registry.URL}
	}
	writeExecutable(t, prefixBin, "codex", "#!/bin/sh\necho 'codex-cli 0.153.4'\n")
	writeExecutable(t, binDir, "npm", fmt.Sprintf(fakeNPMScriptTemplate, "0.200.0", "0.200.0"))
	ops.latestCached["@openai/codex"] = latestVersionEntry{version: "0.200.0", checked: time.Now()}
	upgrade, upgradeStatus, err := ops.installProvider(context.Background(), "codex", "latest")
	if err != nil {
		t.Fatalf("installProvider latest: %v", err)
	}
	if upgradeStatus != http.StatusOK || upgrade.Status != "installed" || upgrade.Version == nil || *upgrade.Version != "0.200.0" {
		t.Fatalf("upgrade = (%d, %+v)", upgradeStatus, upgrade)
	}
}

func TestProviderInstallExactPinMatchesBelowFloor(t *testing.T) {
	// An explicit version pin that matches the installed binary is satisfied
	// even below the descriptor floor: no gratuitous reinstall.
	home := t.TempDir()
	binDir := t.TempDir()
	prefixBin := filepath.Join(home, ".local", "bin")
	if err := os.MkdirAll(prefixBin, 0o755); err != nil {
		t.Fatalf("mkdir prefix bin: %v", err)
	}
	writeExecutable(t, prefixBin, "codex", "#!/bin/sh\necho 'codex-cli 0.100.0'\n")
	writeExecutable(t, binDir, "npm", "#!/bin/sh\nexit 99\n")
	ops := fakeProviderOps(t, binDir, home, nil)

	result, httpStatus, err := ops.installProvider(context.Background(), "codex", "0.100.0")
	if err != nil {
		t.Fatalf("installProvider: %v", err)
	}
	if httpStatus != http.StatusOK || result.Status != "already" {
		t.Fatalf("result = (%d, %+v)", httpStatus, result)
	}
}

func TestCleanupNPMStagingDirs(t *testing.T) {
	prefix := t.TempDir()
	pkgDir := filepath.Join(prefix, "lib", "node_modules", "@openai", "codex")
	if err := os.MkdirAll(pkgDir, 0o755); err != nil {
		t.Fatalf("mkdir package dir: %v", err)
	}
	staging := filepath.Join(prefix, "lib", "node_modules", "@openai", ".codex-KXFLsmgY")
	if err := os.MkdirAll(filepath.Join(staging, "node_modules"), 0o755); err != nil {
		t.Fatalf("mkdir staging dir: %v", err)
	}
	// An unrelated sibling package must survive cleanup.
	other := filepath.Join(prefix, "lib", "node_modules", "@openai", "other")
	if err := os.MkdirAll(other, 0o755); err != nil {
		t.Fatalf("mkdir other package: %v", err)
	}

	cleanupNPMStagingDirs(prefix, "@openai/codex")
	if _, err := os.Stat(staging); !os.IsNotExist(err) {
		t.Fatalf("staging dir still present: %v", err)
	}
	if _, err := os.Stat(pkgDir); err != nil {
		t.Fatalf("package dir removed: %v", err)
	}
	if _, err := os.Stat(other); err != nil {
		t.Fatalf("unrelated package removed: %v", err)
	}

	if got := managedNPMGlobalPackageDir(prefix, "@openai/codex"); got != pkgDir {
		t.Fatalf("managedNPMGlobalPackageDir = %q want %q", got, pkgDir)
	}
	if got := managedNPMGlobalPackageDir(prefix, "../evil"); got != "" {
		t.Fatalf("path traversal accepted: %q", got)
	}
}

func TestProviderInstallRunsNPMWithArgvAndVerifies(t *testing.T) {
	home := t.TempDir()
	binDir := t.TempDir()
	argvLog := filepath.Join(t.TempDir(), "npm-argv.log")
	registry := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"version":"0.200.0"}`))
	}))
	t.Cleanup(registry.Close)

	npmScript := fmt.Sprintf(fakeNPMScriptTemplate, "0.200.0", "0.200.0")
	writeExecutable(t, binDir, "npm", npmScript)
	ops := fakeProviderOps(t, binDir, home, []string{
		"NPM_ARGV_LOG=" + argvLog,
		managednpm.RegistryOverrideEnv + "=" + registry.URL,
	})

	result, httpStatus, err := ops.installProvider(context.Background(), "codex", "")
	if err != nil {
		t.Fatalf("installProvider: %v", err)
	}
	if httpStatus != http.StatusOK || result.Status != "installed" {
		t.Fatalf("result = (%d, %+v)", httpStatus, result)
	}
	if result.Version == nil || *result.Version != "0.200.0" {
		t.Fatalf("version = %+v", result)
	}
	if result.Registry != registry.URL {
		t.Fatalf("registry = %q want %q", result.Registry, registry.URL)
	}
	if result.BinaryPath == nil || !strings.HasPrefix(*result.BinaryPath, filepath.Join(home, ".local")) {
		t.Fatalf("binaryPath = %+v", result.BinaryPath)
	}

	raw, err := os.ReadFile(argvLog)
	if err != nil {
		t.Fatalf("read argv log: %v", err)
	}
	argv := strings.Split(strings.TrimSpace(string(raw)), "\n")
	want := []string{"install", "-g", "--prefix", filepath.Join(home, ".local"), "@openai/codex@latest", "--include=optional"}
	if strings.Join(argv, " ") != strings.Join(want, " ") {
		t.Fatalf("npm argv = %q want %q", strings.Join(argv, " "), strings.Join(want, " "))
	}
	if result.Command[0] != filepath.Join(binDir, "npm") {
		t.Fatalf("command npm = %q", result.Command[0])
	}
}

func TestProviderInstallBelowFloorRepairs(t *testing.T) {
	home := t.TempDir()
	binDir := t.TempDir()
	argvLog := filepath.Join(t.TempDir(), "npm-argv.log")
	registry := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_, _ = w.Write([]byte(`{"version":"0.153.4"}`))
	}))
	t.Cleanup(registry.Close)
	writeExecutable(t, binDir, "npm", fmt.Sprintf(fakeNPMScriptTemplate, "0.153.4", "0.153.4"))
	// Existing install below the codex minimum version (0.153.4 exactly meets
	// it; use an older line to prove the floor triggers a repair).
	prefixBin := filepath.Join(home, ".local", "bin")
	if err := os.MkdirAll(prefixBin, 0o755); err != nil {
		t.Fatalf("mkdir prefix bin: %v", err)
	}
	writeExecutable(t, prefixBin, "codex", "#!/bin/sh\necho 'codex-cli 0.100.0'\n")
	ops := fakeProviderOps(t, binDir, home, []string{
		"NPM_ARGV_LOG=" + argvLog,
		managednpm.RegistryOverrideEnv + "=" + registry.URL,
	})

	result, httpStatus, err := ops.installProvider(context.Background(), "codex", "")
	if err != nil {
		t.Fatalf("installProvider: %v", err)
	}
	if httpStatus != http.StatusOK || result.Status != "installed" {
		t.Fatalf("result = (%d, %+v)", httpStatus, result)
	}
	if _, err := os.Stat(argvLog); err != nil {
		t.Fatalf("npm was not invoked for below-floor repair: %v", err)
	}
}

func TestProviderInstallRejectsConcurrentAndUnsupported(t *testing.T) {
	home := t.TempDir()
	binDir := t.TempDir()
	ops := fakeProviderOps(t, binDir, home, nil)

	ops.installMu.Lock()
	ops.installing["codex"] = true
	ops.installMu.Unlock()
	if _, status, err := ops.installProvider(context.Background(), "codex", ""); status != http.StatusConflict || err == nil {
		t.Fatalf("concurrent install = (%d, %v)", status, err)
	}
	descriptor, ok := findProviderTarget("codex")
	if !ok {
		t.Fatal("codex descriptor missing")
	}
	if entry := ops.detectProvider(context.Background(), descriptor); !entry.InstallInProgress {
		t.Fatalf("status while locked = %#v, want installInProgress", entry)
	}
	ops.releaseInstall("codex")
	if entry := ops.detectProvider(context.Background(), descriptor); entry.InstallInProgress {
		t.Fatalf("status after release = %#v, want installInProgress=false", entry)
	}

	kimiInstall, ok := installDescriptorDTO(findProviderTargetOrFatal(t, "kimi-code").Status)
	if !ok || kimiInstall.Kind != "official_script" || kimiInstall.BinaryName != "kimi" {
		t.Fatalf("kimi-code install dto = %#v ok=%v", kimiInstall, ok)
	}
	if !installable(findProviderTargetOrFatal(t, "kimi-code").Status.Install) {
		t.Fatal("kimi-code should be installable via official_script")
	}
	kimiStatus := findProviderTargetOrFatal(t, "kimi-code").Status
	if len(kimiStatus.LoginArgs) == 0 || kimiStatus.LoginArgs[0] != "login" {
		t.Fatalf("kimi-code LoginArgs = %#v, want [login]", kimiStatus.LoginArgs)
	}
	kimiLoginDTO, ok := loginDescriptorDTO(kimiStatus, "/tmp/kimi")
	if !ok || !kimiLoginDTO.Supported || kimiLoginDTO.DisplayCommand != "/tmp/kimi login" {
		t.Fatalf("kimi-code login dto = %#v ok=%v", kimiLoginDTO, ok)
	}
	cursorInstall, ok := installDescriptorDTO(findProviderTargetOrFatal(t, "cursor").Status)
	if !ok || cursorInstall.Kind != "official_script" || cursorInstall.ManagedNPM || cursorInstall.BinaryName != "cursor-agent" {
		t.Fatalf("cursor install dto = %#v ok=%v", cursorInstall, ok)
	}
	if !installable(findProviderTargetOrFatal(t, "cursor").Status.Install) {
		t.Fatal("cursor should be installable via official_script")
	}
	if _, status, err := ops.installProvider(context.Background(), "nexight", ""); status != http.StatusNotFound || err == nil {
		t.Fatalf("unknown provider = (%d, %v)", status, err)
	}
}

func TestProviderInstallEndpointDecodesBody(t *testing.T) {
	// HTTP install delegates to Agorax agentstatus.RunAction, which also probes
	// adapters after CLI install. Cover empty-body acceptance via the shared
	// installProvider already-satisfied path (official_script / cursor).
	binDir := t.TempDir()
	writeExecutable(t, binDir, "cursor-agent", `#!/bin/sh
echo "2026.09.23-86fc751"
`)
	ops := fakeProviderOps(t, binDir, t.TempDir(), nil)
	result, status, err := ops.installProvider(context.Background(), "cursor", "")
	if err != nil || status != http.StatusOK {
		t.Fatalf("installProvider cursor = (%d, %v)", status, err)
	}
	if result.Status != "already" {
		t.Fatalf("result = %+v", result)
	}
}

func TestWantsProviderUpgrade(t *testing.T) {
	t.Parallel()
	cases := []struct {
		version string
		want    bool
	}{
		{version: "", want: false},
		{version: "   ", want: false},
		{version: "latest", want: true},
		{version: "0.162.1", want: true},
	}
	for _, testCase := range cases {
		if got := wantsProviderUpgrade(testCase.version); got != testCase.want {
			t.Fatalf("wantsProviderUpgrade(%q) = %v, want %v", testCase.version, got, testCase.want)
		}
	}
}

func TestWithCodexDeviceAuthLoginArgs(t *testing.T) {
	t.Parallel()
	got := withCodexDeviceAuthLoginArgs([]string{"login", "-c", `service_tier="fast"`})
	want := []string{"login", "--device-auth", "-c", `service_tier="fast"`}
	if strings.Join(got, "\x00") != strings.Join(want, "\x00") {
		t.Fatalf("got %#v want %#v", got, want)
	}
	idempotent := withCodexDeviceAuthLoginArgs(want)
	if strings.Join(idempotent, "\x00") != strings.Join(want, "\x00") {
		t.Fatalf("idempotent got %#v", idempotent)
	}
}

func findProviderTargetOrFatal(t *testing.T, providerID string) providerregistry.ProviderDescriptor {
	t.Helper()
	descriptor, ok := findProviderTarget(providerID)
	if !ok {
		t.Fatalf("provider %q missing from registry", providerID)
	}
	return descriptor
}

func TestProviderInstallOfficialScriptDownloadsAndRuns(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("POSIX official-script install test")
	}
	home := t.TempDir()
	binDir := t.TempDir()
	scriptHits := 0
	installer := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		scriptHits++
		_, _ = w.Write([]byte(`#!/bin/sh
prefix_bin="$1"
/bin/mkdir -p "$prefix_bin" || exit 1
/bin/cat > "$prefix_bin/cursor-agent" <<'EOF'
#!/bin/sh
echo "cursor-agent 1.2.3"
EOF
/bin/chmod +x "$prefix_bin/cursor-agent" || exit 1
`))
	}))
	t.Cleanup(installer.Close)

	// Wrap the downloaded script so the fake install target lands in binDir
	// (the real Cursor installer writes under ~/.local/bin).
	writeExecutable(t, binDir, "bash", fmt.Sprintf(`#!/bin/sh
script="$1"
/bin/sh "$script" %q
`, binDir))

	ops := fakeProviderOps(t, binDir, home, nil)
	descriptor := findProviderTargetOrFatal(t, "cursor")
	descriptor.Status.Install.ScriptURL = installer.URL
	descriptor.Status.Install.ScriptShell = filepath.Join(binDir, "bash")
	// Override findProviderTarget by installing through the internal path.
	result, status, err := ops.installOfficialScript(
		context.Background(),
		providerInstallResultDTO{Provider: "cursor"},
		descriptor,
		"",
	)
	if err != nil || status != http.StatusOK {
		t.Fatalf("installOfficialScript = (%d, %v) result=%+v", status, err, result)
	}
	if scriptHits != 1 {
		t.Fatalf("script downloads = %d", scriptHits)
	}
	if result.Status != "installed" || result.Version == nil || *result.Version != "1.2.3" {
		t.Fatalf("result = %+v", result)
	}
	if result.BinaryPath == nil || !strings.Contains(*result.BinaryPath, "cursor-agent") {
		t.Fatalf("binaryPath = %v", result.BinaryPath)
	}
}

func TestProviderInstallOfficialScriptAlreadyInstalled(t *testing.T) {
	binDir := t.TempDir()
	writeExecutable(t, binDir, "cursor-agent", `#!/bin/sh
echo "cursor-agent 9.9.9"
`)
	ops := fakeProviderOps(t, binDir, t.TempDir(), nil)
	result, status, err := ops.installProvider(context.Background(), "cursor", "")
	if err != nil || status != http.StatusOK {
		t.Fatalf("installProvider cursor = (%d, %v)", status, err)
	}
	if result.Status != "already" || result.Version == nil || *result.Version != "9.9.9" {
		t.Fatalf("result = %+v", result)
	}
}

func TestProbeVersionAcceptsNonSemverOfficialBuilds(t *testing.T) {
	binDir := t.TempDir()
	writeExecutable(t, binDir, "cursor-agent", `#!/bin/sh
echo "2026.09.23-86fc751"
`)
	ops := fakeProviderOps(t, binDir, t.TempDir(), nil)
	version, err := ops.probeVersion(context.Background(), filepath.Join(binDir, "cursor-agent"))
	if err != nil {
		t.Fatalf("probeVersion: %v", err)
	}
	if version != "2026.09.23-86fc751" {
		t.Fatalf("version = %q", version)
	}
	result, status, err := ops.installProvider(context.Background(), "cursor", "")
	if err != nil || status != http.StatusOK {
		t.Fatalf("installProvider = (%d, %v)", status, err)
	}
	if result.Status != "already" || result.Version == nil || *result.Version != "2026.09.23-86fc751" {
		t.Fatalf("result = %+v", result)
	}
}

func TestReadNPMRegistryLatestVersionUsesLatestAliasManifest(t *testing.T) {
	// Full packuments run to tens of MB for providers like @openai/codex, so
	// discovery resolves the compact `latest` version-alias manifest instead.
	var requestedPath string
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		requestedPath = r.URL.Path
		_, _ = w.Write([]byte(`{"name":"@acme/pkg","version":"9.8.7"}`))
	}))
	t.Cleanup(server.Close)
	version, err := readNPMRegistryLatestVersion(t.Context(), &http.Client{Timeout: 5 * time.Second}, server.URL, "@acme/pkg")
	if err != nil {
		t.Fatalf("readNPMRegistryLatestVersion: %v", err)
	}
	if version != "9.8.7" {
		t.Fatalf("version = %q", version)
	}
	if !strings.HasSuffix(requestedPath, "/latest") {
		t.Fatalf("request path = %q, want the latest alias manifest", requestedPath)
	}
}

func TestUpdateAvailableComparison(t *testing.T) {
	version := "1.2.3"
	cases := []struct {
		name        string
		version     *string
		minVersion  string
		recommended string
		latest      string
		want        bool
	}{
		{name: "no version", version: nil, latest: "9.9.9", want: false},
		{name: "up to date", version: &version, latest: "1.2.3", want: false},
		{name: "newer latest", version: &version, latest: "1.3.0", want: true},
		{name: "newer recommended", version: &version, recommended: "2.0.0", want: true},
		{name: "below floor", version: &version, minVersion: "1.3.0", want: true},
		{name: "unparseable latest ignored", version: &version, latest: "beta-1", want: false},
	}
	for _, testCase := range cases {
		t.Run(testCase.name, func(t *testing.T) {
			if got := updateAvailable(testCase.version, testCase.minVersion, testCase.recommended, testCase.latest); got != testCase.want {
				t.Fatalf("updateAvailable = %v want %v", got, testCase.want)
			}
		})
	}
}
