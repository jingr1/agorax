package main

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"sync"
	"time"

	"agorax.local/agent-daemon/packages/agent/daemon/agentstatus"
	"agorax.local/agent-daemon/packages/agent/daemon/managednpm"
	"agorax.local/agent-daemon/packages/agent/daemon/providerregistry"
	"agorax.local/agent-daemon/packages/agent/daemon/providerstatus"
	"agorax.local/agent-daemon/packages/agent/daemon/runtimecmd"
	storesqlite "agorax.local/agent-daemon/packages/agent/store-sqlite"
)

// This file is the thin HTTP adapter over provider runtime detection and
// managed npm installation. Detection resolves provider CLIs through the
// runtime command resolver (PATH + user-managed npm launcher directories),
// never through provider identity assumptions; installs run npm with an argv
// array through the platform exec boundary in providerexec_*.go.

const (
	// providerVersionTimeout bounds `--version` probes so a hung CLI cannot
	// stall the aggregate status read.
	providerVersionTimeout = 3 * time.Second
	// providerAuthTimeoutMax caps descriptor-owned auth status commands. The
	// claude descriptor declares a 600s budget for interactive logins; a
	// read-only status probe must finish well inside that.
	providerAuthTimeoutMax = 10 * time.Second
	// providerInstallTimeout bounds the whole managed npm / official-script
	// install including large platform optional-dependency downloads.
	providerInstallTimeout = 10 * time.Minute
	// providerScriptDownloadTimeout bounds a single official installer script
	// download attempt (retries use a fresh timeout each time).
	providerScriptDownloadTimeout = 2 * time.Minute
	providerScriptDownloadAttempts = 3
	// providerRegistryProbeTimeout bounds a single registry metadata probe so
	// status reads fail fast when the network is down.
	providerRegistryProbeTimeout = 2 * time.Second
	// providerLatestVersionTTL caches npm "latest" versions so the status read
	// and the install idempotency check do not hammer registries.
	providerLatestVersionTTL = time.Minute
	// installLogTailLines bounds the npm output attached to install errors.
	installLogTailLines = 20
)

// kimiCodeTargetID mirrors the daemon catalog entry the runtime registers for
// the Kimi ACP extension; there is no providerregistry descriptor for it yet.
const kimiCodeTargetID = "extension:kimi-code"

var errProviderInstallUnsupported = errors.New("provider install is not supported")

// knownProviderTargets lists every runtime the status endpoint reports. Order
// matches the daemon catalog: codex, claude-code, cursor, opencode, kimi-code.
func knownProviderTargets() []providerregistry.ProviderDescriptor {
	ids := []string{
		providerregistry.CodexProviderID,
		providerregistry.ClaudeCodeProviderID,
		providerregistry.CursorProviderID,
		providerregistry.OpenCodeProviderID,
	}
	targets := make([]providerregistry.ProviderDescriptor, 0, len(ids)+1)
	for _, id := range ids {
		descriptor, ok := providerregistry.Find(id)
		if !ok {
			continue
		}
		targets = append(targets, descriptor)
	}
	// Kimi Code ships as an ACP extension without a full providerregistry
	// descriptor yet. Status still uses bare CLI detection; install is driven
	// by the official script (npm requires Node ≥22.19, which hosts may lack).
	targets = append(targets, providerregistry.ProviderDescriptor{
		Identity: providerregistry.IdentityDescriptor{ID: "kimi-code"},
		Target:   providerregistry.TargetDescriptor{ID: kimiCodeTargetID},
		Status: providerregistry.StatusDescriptor{
			Kind:                 providerregistry.StatusKindGenericCLI,
			BinaryNames:          []string{"kimi"},
			AuthMarkerParserKind: providerregistry.AuthMarkerParserKindFileExists,
			// Device-code login writes OAuth tokens here; thin status has no
			// AuthStatusCommand yet, so marker presence drives auth readiness.
			AuthMarkerPaths: []string{"~/.kimi-code/credentials/kimi-code.json"},
			LoginArgs:       []string{"login"},
			Install: providerregistry.InstallerDescriptor{
				Kind:                     providerregistry.InstallerKindOfficialScript,
				DisplayCommand:           "curl -fsSL https://code.kimi.com/kimi-code/install.sh | bash",
				BinaryName:               "kimi",
				ScriptURL:                "https://code.kimi.com/kimi-code/install.sh",
				ScriptShell:              "bash",
				WindowsFallback:          providerregistry.InstallerWindowsFallbackPowerShell,
				WindowsPowerShellCommand: "irm https://code.kimi.com/kimi-code/install.ps1 | iex",
			},
			Update: providerregistry.UpdateDescriptor{
				Capability:        providerregistry.UpdateCapabilityUnsupported,
				UnsupportedReason: providerregistry.UpdateUnsupportedReasonOfficialScript,
			},
		},
	})
	return targets
}

type providerAuthDTO struct {
	Status       string  `json:"status"`
	AccountLabel *string `json:"accountLabel"`
	AuthMethod   *string `json:"authMethod"`
}

type providerInstallDTO struct {
	Kind           string `json:"kind"`
	DisplayCommand string `json:"displayCommand"`
	PackageName    string `json:"packageName"`
	BinaryName     string `json:"binaryName"`
	// ManagedNPM is true when the daemon install path is managed npm /
	// codex-cli-latest (argv npm install). Official-script providers still
	// expose an install DTO with managedNpm=false; the install endpoint
	// drives them via ScriptURL / Windows fallback instead.
	ManagedNPM bool `json:"managedNpm"`
}

type providerUpdateDTO struct {
	Capability        string  `json:"capability"`
	Source            string  `json:"source"`
	UnsupportedReason string  `json:"unsupportedReason,omitempty"`
	CurrentVersion    *string `json:"currentVersion,omitempty"`
	LatestVersion     *string `json:"latestVersion,omitempty"`
	LastCheckedAt     *string `json:"lastCheckedAt,omitempty"`
	ReasonCode        string  `json:"reasonCode,omitempty"`
}

type providerLoginDTO struct {
	// Supported is true when the descriptor declares LoginArgs the daemon can
	// launch interactively via POST /v1/providers/{provider}/login.
	Supported      bool     `json:"supported"`
	DisplayCommand string   `json:"displayCommand"`
	Command        []string `json:"command,omitempty"`
}

type providerStatusDTO struct {
	Provider   string `json:"provider"`
	TargetID   string `json:"targetId"`
	Registered bool   `json:"registered"`
	Installed  bool   `json:"installed"`
	// InstallInProgress is true while a managed npm install *or update* for
	// this provider is the active action. UI clients should show
	// installing/upgrading and refuse another click instead of treating
	// concurrent POSTs as hard failures.
	InstallInProgress bool `json:"installInProgress"`
	// LoginInProgress is true while an interactive login process started by the
	// daemon is still being watched for auth readiness.
	LoginInProgress bool `json:"loginInProgress"`
	// BinaryPath/Version/LatestVersion are null when they cannot be resolved.
	BinaryPath         *string             `json:"binaryPath"`
	Version            *string             `json:"version"`
	MinVersion         string              `json:"minVersion,omitempty"`
	RecommendedVersion string              `json:"recommendedVersion,omitempty"`
	LatestVersion      *string             `json:"latestVersion"`
	UpdateAvailable    bool                `json:"updateAvailable"`
	Auth               providerAuthDTO     `json:"auth"`
	Install            *providerInstallDTO `json:"install,omitempty"`
	Login              *providerLoginDTO   `json:"login,omitempty"`
	Update             providerUpdateDTO   `json:"update"`
	// Error carries non-fatal detection failures (version probe timeout, auth
	// command failure, registry unreachable); it never fails the aggregate.
	Error string `json:"error,omitempty"`
}

type providerStatusListDTO struct {
	CapturedAt string              `json:"capturedAt"`
	Providers  []providerStatusDTO `json:"providers"`
}

type providerInstallResultDTO struct {
	Provider  string   `json:"provider"`
	Status    string   `json:"status"` // "installed" | "already"
	Version   *string  `json:"version,omitempty"`
	BinaryPath *string `json:"binaryPath,omitempty"`
	Command   []string `json:"command,omitempty"`
	Registry  string   `json:"registry,omitempty"`
}

type latestVersionEntry struct {
	version string
	checked time.Time
}

type providerOps struct {
	resolver            runtimecmd.Resolver
	registeredProviders func() map[string]bool
	httpClient          *http.Client
	environ             func() []string
	homeDir             func() (string, error)
	now                 func() time.Time

	// statusService is Agorax agentstatus — authoritative for detect/install/update.
	statusService *agentstatus.Service

	latestMu     sync.Mutex
	latestCached map[string]latestVersionEntry

	installMu  sync.Mutex
	installing map[string]bool

	loginMu    sync.Mutex
	loggingIn  map[string]bool
	// loginEpoch is bumped when an interactive「重新检测」cancels in-flight
	// login watches so a finished terminal session cannot keep loginInProgress
	// stuck and block a fresh Login click.
	loginEpoch uint64

	// userEnabled records Runtimes Switch preferences by identity id. Needed
	// for providers (notably kimi-code) that appear in status without a
	// migrated runtime adapter — RegisteredProviders never lists them, so the
	// Switch would otherwise ignore enable POSTs.
	userEnabledMu sync.Mutex
	userEnabled   map[string]bool

	// targetStore persists enable preferences across daemon restarts
	// (agent_targets.enabled). Nil in unit tests that only exercise memory.
	targetStore agentTargetEnableStore
}

// agentTargetEnableStore is the persistence surface for Runtimes enable
// preferences. *storesqlite.Store satisfies it.
type agentTargetEnableStore interface {
	ListAgentTargets(ctx context.Context) ([]storesqlite.Target, error)
	GetAgentTarget(ctx context.Context, id string) (storesqlite.Target, error)
	PutAgentTarget(ctx context.Context, target storesqlite.Target) (storesqlite.Target, error)
	SetAgentTargetEnabled(ctx context.Context, id string, enabled bool) error
}

func defaultProviderOps(registeredProviders func() map[string]bool) *providerOps {
	ops := &providerOps{
		resolver:            runtimecmd.Resolver{},
		registeredProviders: registeredProviders,
		httpClient:          &http.Client{Timeout: providerRegistryProbeTimeout},
		environ:             os.Environ,
		homeDir:             os.UserHomeDir,
		now:                 time.Now,
		latestCached:        map[string]latestVersionEntry{},
		installing:          map[string]bool{},
		loggingIn:           map[string]bool{},
		userEnabled:         map[string]bool{},
	}
	svc := newAgentStatusService(ops.environ, ops.homeDir)
	ops.statusService = &svc
	ops.resolver.Environ = ops.environ
	ops.resolver.HomeDir = ops.homeDir
	return ops
}

func (o *providerOps) resolveBinary(binaryNames []string) string {
	return strings.TrimSpace(o.resolver.ResolveBinary(binaryNames, nil))
}

// runProviderCommand executes a resolved provider binary through the platform
// exec boundary with an argv array and a bounded runtime.
func (o *providerOps) runProviderCommand(ctx context.Context, timeout time.Duration, binary string, args ...string) ([]byte, error) {
	commandCtx, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()
	command := newProviderExecCommand(commandCtx, binary, args...)
	output, err := command.CombinedOutput()
	if errors.Is(commandCtx.Err(), context.DeadlineExceeded) {
		return output, fmt.Errorf("timed out after %s", timeout)
	}
	return output, err
}

func (o *providerOps) probeVersion(ctx context.Context, binary string) (string, error) {
	output, err := o.runProviderCommand(ctx, providerVersionTimeout, binary, "--version")
	if err != nil {
		return "", err
	}
	version, ok := managednpm.ExtractVersion(string(output))
	if ok {
		return version, nil
	}
	// Official CLIs such as Cursor report date-hash builds (e.g.
	// "2026.09.23-86fc751") that are not stable x.y.z. Keep a trimmed token so
	// install verification and status still succeed when the binary is healthy.
	if token := firstNonEmptyVersionToken(string(output)); token != "" {
		return token, nil
	}
	return "", fmt.Errorf("could not parse a version from %q", strings.TrimSpace(string(output)))
}

func firstNonEmptyVersionToken(output string) string {
	for _, line := range strings.Split(output, "\n") {
		line = strings.TrimSpace(line)
		if line == "" {
			continue
		}
		fields := strings.Fields(line)
		if len(fields) == 0 {
			continue
		}
		return fields[len(fields)-1]
	}
	return ""
}

// detectProvider aggregates one provider's runtime state. Every probe is
// non-fatal: failures land in the entry's Error field so one broken provider
// cannot blank the aggregate.
func (o *providerOps) detectProvider(ctx context.Context, descriptor providerregistry.ProviderDescriptor) providerStatusDTO {
	status := descriptor.Status
	entry := providerStatusDTO{
		Provider:           descriptor.Identity.ID,
		TargetID:           descriptor.Target.ID,
		Registered:         o.isRegistered(descriptor),
		InstallInProgress:  o.isInstallInProgress(descriptor.Identity.ID),
		LoginInProgress:    o.isLoginInProgress(descriptor.Identity.ID),
		MinVersion:         status.MinVersion,
		RecommendedVersion: status.Install.RecommendedVersion,
		Auth:               providerAuthDTO{Status: string(providerstatus.AuthUnknown)},
		Update: providerUpdateDTO{
			Capability:        string(status.Update.Capability),
			Source:            string(status.Update.Source),
			UnsupportedReason: status.Update.UnsupportedReason,
		},
	}
	if install, ok := installDescriptorDTO(status); ok {
		entry.Install = install
	}
	if login, ok := loginDescriptorDTO(status, ""); ok {
		entry.Login = login
	}

	binary := o.resolveBinary(status.BinaryNames)
	if binary == "" {
		return entry
	}
	entry.Installed = true
	entry.BinaryPath = stringPointer(binary)
	if login, ok := loginDescriptorDTO(status, binary); ok {
		entry.Login = login
	}

	var probeErrors []string
	version, err := o.probeVersion(ctx, binary)
	if err != nil {
		probeErrors = append(probeErrors, fmt.Sprintf("version probe: %v", err))
	} else {
		entry.Version = stringPointer(version)
	}

	if len(status.AuthStatusCommand) > 0 {
		timeout := time.Duration(status.AuthStatusCommandTimeoutSeconds) * time.Second
		if timeout <= 0 || timeout > providerAuthTimeoutMax {
			timeout = providerAuthTimeoutMax
		}
		output, err := o.runProviderCommand(ctx, timeout, binary, status.AuthStatusCommand...)
		if err != nil {
			probeErrors = append(probeErrors, fmt.Sprintf("auth probe: %v", err))
		} else if auth, ok := providerstatus.ParseAuthStatusOutput(status.AuthOutputParserKind, output); ok {
			entry.Auth = providerAuthDTO{Status: string(auth.Status)}
			if auth.AccountLabel != "" {
				entry.Auth.AccountLabel = stringPointer(auth.AccountLabel)
			}
			if auth.AuthMethod != "" {
				entry.Auth.AuthMethod = stringPointer(auth.AuthMethod)
			}
		}
	} else if auth, ok := o.probeAuthFromMarkers(status); ok {
		entry.Auth = providerAuthDTO{Status: string(auth)}
	} else if len(status.AuthMarkerPaths) > 0 {
		// Marker declared but absent — treat as login required so the wizard
		// offers daemon login instead of leaving auth as unknown forever.
		entry.Auth = providerAuthDTO{Status: string(providerstatus.AuthRequired)}
	}

	if entry.Version != nil {
		entry.Update.CurrentVersion = entry.Version
	}
	if installable(descriptor.Status.Install) {
		checkedAt := o.now().UTC().Format(time.RFC3339)
		entry.Update.LastCheckedAt = stringPointer(checkedAt)
		latest := o.latestVersion(ctx, descriptor.Status.Install.PackageName)
		if latest != "" {
			entry.LatestVersion = stringPointer(latest)
			entry.Update.LatestVersion = stringPointer(latest)
		} else {
			// Discovery ran but returned nothing — surface Agorax-parity
			// check-failed so the Runtimes summary can distinguish "up to date"
			// from "could not check".
			entry.Update.ReasonCode = "registry_unreachable"
		}
		entry.UpdateAvailable = updateAvailable(entry.Version, status.MinVersion, status.Install.RecommendedVersion, latest)
	} else {
		entry.UpdateAvailable = updateAvailable(entry.Version, status.MinVersion, status.Install.RecommendedVersion, "")
	}

	entry.Error = strings.Join(probeErrors, "; ")
	return entry
}

func (o *providerOps) isRegistered(descriptor providerregistry.ProviderDescriptor) bool {
	id := normalizeProviderID(descriptor.Identity.ID)
	adapterRegistered := false
	if o.registeredProviders != nil {
		registered := o.registeredProviders()
		if registered[descriptor.Identity.ID] || registered[descriptor.Target.ID] {
			adapterRegistered = true
		}
		// The daemon catalog registers the Kimi ACP extension under its runtime
		// provider key rather than its target id.
		if !adapterRegistered && id == "kimi-code" && registered["acp:kimi-code"] {
			adapterRegistered = true
		}
	}
	if enabled, ok := o.userEnabledPreference(id); ok {
		if !enabled {
			return false
		}
		// Enabled preference alone is enough for hosts without a migrated
		// adapter (kimi-code today); adapter presence still unlocks others.
		return adapterRegistered || id == "kimi-code"
	}
	return adapterRegistered
}

// setUserEnabledPreference stores the Runtimes enable Switch for identity id
// in memory and, when a target store is attached, durably on agent_targets.
func (o *providerOps) setUserEnabledPreference(providerID string, enabled bool) error {
	key := normalizeProviderID(providerID)
	if key == "" {
		return fmt.Errorf("provider id is required")
	}
	o.userEnabledMu.Lock()
	if o.userEnabled == nil {
		o.userEnabled = map[string]bool{}
	}
	o.userEnabled[key] = enabled
	o.userEnabledMu.Unlock()
	if o.targetStore == nil {
		return nil
	}
	return o.persistEnabledPreference(key, enabled)
}

func (o *providerOps) userEnabledPreference(providerID string) (enabled bool, ok bool) {
	key := normalizeProviderID(providerID)
	if key == "" {
		return false, false
	}
	o.userEnabledMu.Lock()
	defer o.userEnabledMu.Unlock()
	enabled, ok = o.userEnabled[key]
	return enabled, ok
}

func (o *providerOps) attachTargetStore(store agentTargetEnableStore) {
	o.targetStore = store
}

// hydrateEnabledFromStore loads durable enable preferences into memory so a
// daemon restart keeps Runtimes Switch state. Missing rows leave the preference
// unset (adapter presence alone decides registered).
func (o *providerOps) hydrateEnabledFromStore(ctx context.Context) error {
	if o == nil || o.targetStore == nil {
		return nil
	}
	targets, err := o.targetStore.ListAgentTargets(ctx)
	if err != nil {
		return err
	}
	byTargetID := map[string]bool{}
	byProvider := map[string]bool{}
	for _, target := range targets {
		byTargetID[normalizeProviderID(target.ID)] = target.Enabled
		if provider := normalizeProviderID(target.Provider); provider != "" {
			byProvider[provider] = target.Enabled
		}
	}
	o.userEnabledMu.Lock()
	defer o.userEnabledMu.Unlock()
	if o.userEnabled == nil {
		o.userEnabled = map[string]bool{}
	}
	for _, descriptor := range knownProviderTargets() {
		identity := normalizeProviderID(descriptor.Identity.ID)
		if identity == "" {
			continue
		}
		if enabled, ok := byProvider[identity]; ok {
			o.userEnabled[identity] = enabled
			continue
		}
		targetID := normalizeProviderID(descriptor.Target.ID)
		if targetID == "" {
			continue
		}
		if enabled, ok := byTargetID[targetID]; ok {
			o.userEnabled[identity] = enabled
		}
	}
	return nil
}

func (o *providerOps) persistEnabledPreference(identity string, enabled bool) error {
	descriptor, ok := findProviderTarget(identity)
	if !ok {
		return fmt.Errorf("unknown provider %q", identity)
	}
	targetID := strings.TrimSpace(descriptor.Target.ID)
	if targetID == "" {
		targetID = descriptor.Identity.ID
	}
	ctx := context.Background()
	err := o.targetStore.SetAgentTargetEnabled(ctx, targetID, enabled)
	if err == nil {
		return nil
	}
	if !errors.Is(err, storesqlite.ErrAgentTargetNotFound) {
		return err
	}
	name := strings.TrimSpace(descriptor.Identity.DisplayName)
	if name == "" {
		name = descriptor.Identity.ID
	}
	_, err = o.targetStore.PutAgentTarget(ctx, storesqlite.Target{
		ID:            targetID,
		Provider:      descriptor.Identity.ID,
		LaunchRefJSON: `{"type":"local_cli","provider":"` + descriptor.Identity.ID + `"}`,
		Name:          name,
		IconKey:       descriptor.Identity.ID,
		Enabled:       enabled,
		Source:        "user",
		SortOrder:     100,
	})
	return err
}

// applyEnabledPreferencesToRuntime pushes hydrated preferences onto the
// controller so disabled providers stay out of RegisteredProviders after restart.
func (o *providerOps) applyEnabledPreferencesToRuntime(setEnabled func(provider string, enabled bool)) {
	if o == nil || setEnabled == nil {
		return
	}
	o.userEnabledMu.Lock()
	prefs := make(map[string]bool, len(o.userEnabled))
	for key, enabled := range o.userEnabled {
		prefs[key] = enabled
	}
	o.userEnabledMu.Unlock()
	for _, descriptor := range knownProviderTargets() {
		identity := normalizeProviderID(descriptor.Identity.ID)
		enabled, ok := prefs[identity]
		if !ok {
			continue
		}
		for _, key := range providerEnableAliases(descriptor) {
			setEnabled(key, enabled)
		}
	}
}

// providerEnableAliases are Controller.SetProviderEnabled keys that must move
// together so status + agent-targets agree after a toggle.
func providerEnableAliases(descriptor providerregistry.ProviderDescriptor) []string {
	id := normalizeProviderID(descriptor.Identity.ID)
	keys := []string{descriptor.Identity.ID}
	if target := strings.TrimSpace(descriptor.Target.ID); target != "" && target != descriptor.Identity.ID {
		keys = append(keys, target)
	}
	if id == "kimi-code" {
		keys = append(keys, "acp:kimi-code")
	}
	return keys
}

// updateAvailable reports whether an installed provider has a newer managed
// release (recommended or registry latest) or has fallen below its minimum
// supported version and needs repair.
func updateAvailable(version *string, minVersion string, recommended string, latest string) bool {
	if version == nil || strings.TrimSpace(*version) == "" {
		return false
	}
	installed := *version
	if minVersion != "" {
		if comparison, ok := managednpm.CompareStableVersions(installed, minVersion); ok && comparison < 0 {
			return true
		}
	}
	for _, candidate := range []string{recommended, latest} {
		if candidate == "" {
			continue
		}
		if comparison, ok := managednpm.CompareStableVersions(installed, candidate); ok && comparison < 0 {
			return true
		}
	}
	return false
}

func installDescriptorDTO(status providerregistry.StatusDescriptor) (*providerInstallDTO, bool) {
	kind := status.Install.Kind
	switch kind {
	case providerregistry.InstallerKindManagedNPM, providerregistry.InstallerKindCodexCLILatest:
		if strings.TrimSpace(status.Install.PackageName) == "" {
			return nil, false
		}
	case providerregistry.InstallerKindOfficialScript:
		if strings.TrimSpace(status.Install.ScriptURL) == "" && strings.TrimSpace(status.Install.DisplayCommand) == "" {
			return nil, false
		}
	default:
		return nil, false
	}
	binaryName := strings.TrimSpace(status.Install.BinaryName)
	if binaryName == "" && len(status.BinaryNames) > 0 {
		binaryName = status.BinaryNames[0]
	}
	managed := kind == providerregistry.InstallerKindManagedNPM || kind == providerregistry.InstallerKindCodexCLILatest
	return &providerInstallDTO{
		Kind:           string(kind),
		DisplayCommand: status.Install.DisplayCommand,
		PackageName:    status.Install.PackageName,
		BinaryName:     binaryName,
		ManagedNPM:     managed,
	}, true
}

// latestVersion returns the npm "latest" dist-tag for packageName, cached for
// providerLatestVersionTTL. Registries are tried in catalog order with short
// per-registry timeouts; an empty string means discovery failed and callers
// must treat update state as unknown rather than current.
func (o *providerOps) latestVersion(ctx context.Context, packageName string) string {
	if o.httpClient == nil {
		return ""
	}
	o.latestMu.Lock()
	if entry, ok := o.latestCached[packageName]; ok && o.now().Sub(entry.checked) < providerLatestVersionTTL {
		o.latestMu.Unlock()
		return entry.version
	}
	o.latestMu.Unlock()

	version := o.fetchLatestVersion(ctx, packageName)
	o.latestMu.Lock()
	o.latestCached[packageName] = latestVersionEntry{version: version, checked: o.now()}
	o.latestMu.Unlock()
	return version
}

func (o *providerOps) fetchLatestVersion(ctx context.Context, packageName string) string {
	registries := managednpm.DefaultRegistries(envValueLast(o.environ(), managednpm.RegistryOverrideEnv))
	for _, registry := range registries {
		probeCtx, cancel := context.WithTimeout(ctx, providerRegistryProbeTimeout)
		version, err := readNPMRegistryLatestVersion(probeCtx, o.httpClient, registry.URL, packageName)
		cancel()
		if err == nil && version != "" {
			return version
		}
	}
	return ""
}

// readNPMRegistryLatestVersion resolves the npm "latest" dist-tag through the
// registry's version-alias manifest (`GET /{pkg}/latest`), a compact document
// — full packuments run to tens of MB for providers like @openai/codex. It
// is the install/status-side companion of the managed npm registry ranking
// machinery.
func readNPMRegistryLatestVersion(ctx context.Context, client *http.Client, registryURL string, packageName string) (string, error) {
	endpoint := managednpm.PackageEndpoint(registryURL, packageName, "latest")
	request, err := http.NewRequestWithContext(ctx, http.MethodGet, endpoint, nil)
	if err != nil {
		return "", err
	}
	response, err := client.Do(request)
	if err != nil {
		return "", err
	}
	defer response.Body.Close()
	if response.StatusCode < 200 || response.StatusCode >= 300 {
		_, _ = io.Copy(io.Discard, io.LimitReader(response.Body, 64*1024))
		return "", fmt.Errorf("registry %s returned %d", registryURL, response.StatusCode)
	}
	var manifest struct {
		Version string `json:"version"`
	}
	if err := json.NewDecoder(io.LimitReader(response.Body, 1024*1024)).Decode(&manifest); err != nil {
		return "", err
	}
	return strings.TrimSpace(manifest.Version), nil
}

// npmRegistryProber adapts raw HTTP metadata probes to the managednpm
// registry-ranking contract used to pick the install registry.
type npmRegistryProber struct {
	client *http.Client
}

func (p npmRegistryProber) ProbeRegistry(ctx context.Context, request managednpm.RegistryProbeRequest) managednpm.RegistryProbeResult {
	started := time.Now()
	_, err := readNPMRegistryLatestVersion(ctx, p.client, request.Registry.URL, request.PackageName)
	reachable := err == nil
	return managednpm.RegistryProbeResult{Reachable: reachable, Complete: reachable, Duration: time.Since(started)}
}

// installProvider runs the descriptor-owned installer for providerID and
// verifies the binary afterwards. It returns the HTTP status to write
// alongside the result: 200 satisfied/already, 409 concurrent install, 422
// unsupported, 502 registry/npm resolution failure, 500 install/verification
// failure.
func (o *providerOps) installProvider(ctx context.Context, providerID string, requestedVersion string) (providerInstallResultDTO, int, error) {
	result := providerInstallResultDTO{Provider: providerID}
	descriptor, ok := findProviderTarget(providerID)
	if !ok {
		return result, http.StatusNotFound, fmt.Errorf("unknown provider %q", providerID)
	}
	if !installable(descriptor.Status.Install) {
		return result, http.StatusUnprocessableEntity, fmt.Errorf("%w for %q", errProviderInstallUnsupported, providerID)
	}
	install := descriptor.Status.Install
	requestedVersion = strings.TrimSpace(requestedVersion)

	if !o.acquireInstall(providerID) {
		return result, http.StatusConflict, fmt.Errorf(
			"an install for %q is already in progress — wait for the current install to finish (up to %s), then retry",
			providerID, providerInstallTimeout,
		)
	}
	defer o.releaseInstall(providerID)

	binary := o.resolveBinary(descriptor.Status.BinaryNames)
	if binary != "" {
		installedVersion, err := o.probeVersion(ctx, binary)
		satisfied := err == nil && installSatisfied(installedVersion, descriptor.Status.MinVersion, requestedVersion, func() string {
			return o.latestVersion(ctx, install.PackageName)
		})
		if satisfied {
			result.Status = "already"
			result.Version = stringPointer(installedVersion)
			result.BinaryPath = stringPointer(binary)
			return result, http.StatusOK, nil
		}
	}

	switch install.Kind {
	case providerregistry.InstallerKindManagedNPM, providerregistry.InstallerKindCodexCLILatest:
		return o.installManagedNPM(ctx, result, descriptor, requestedVersion)
	case providerregistry.InstallerKindOfficialScript:
		return o.installOfficialScript(ctx, result, descriptor, requestedVersion)
	default:
		return result, http.StatusUnprocessableEntity, fmt.Errorf("%w for %q", errProviderInstallUnsupported, providerID)
	}
}

// installManagedNPM assumes the install lock is already held and the
// "already satisfied" short-circuit has been checked.
func (o *providerOps) installManagedNPM(
	ctx context.Context,
	result providerInstallResultDTO,
	descriptor providerregistry.ProviderDescriptor,
	requestedVersion string,
) (providerInstallResultDTO, int, error) {
	install := descriptor.Status.Install
	npmPath := o.resolveBinary([]string{"npm"})
	if npmPath == "" {
		return result, http.StatusBadGateway, errors.New("npm is not available on PATH")
	}
	registry, err := o.selectInstallRegistry(ctx, install)
	if err != nil {
		return result, http.StatusBadGateway, err
	}
	prefix, err := o.installPrefix()
	if err != nil {
		return result, http.StatusInternalServerError, err
	}

	versionSpec := "latest"
	if requestedVersion != "" && requestedVersion != "latest" {
		versionSpec = requestedVersion
	}
	command := []string{npmPath, "install", "-g", "--prefix", prefix, install.PackageName + "@" + versionSpec}
	if install.IncludeOptional {
		command = append(command, "--include=optional")
	}
	result.Command = command
	result.Registry = registry

	// npm leaves a sibling .<package>-<hash> staging directory when an install
	// is interrupted (client disconnect, daemon restart); the next install
	// otherwise fails with ENOTEMPTY before doing any useful work.
	cleanupNPMStagingDirs(prefix, install.PackageName)

	installCtx, cancel := context.WithTimeout(ctx, providerInstallTimeout)
	defer cancel()
	commandOutput, runErr := o.runInstallCommand(installCtx, command, registry)
	if runErr != nil {
		return result, http.StatusInternalServerError, fmt.Errorf("npm install failed: %w (%s)", runErr, tailLines(commandOutput, installLogTailLines))
	}

	installed := o.resolveBinary(descriptor.Status.BinaryNames)
	if installed == "" {
		return result, http.StatusInternalServerError, fmt.Errorf("npm install completed but %q is still not resolvable on PATH", descriptor.Status.BinaryNames[0])
	}
	installedVersion, err := o.probeVersion(ctx, installed)
	if err != nil {
		return result, http.StatusInternalServerError, fmt.Errorf("installed binary failed verification: %w", err)
	}
	result.Status = "installed"
	result.Version = stringPointer(installedVersion)
	result.BinaryPath = stringPointer(installed)
	return result, http.StatusOK, nil
}

// installSatisfied decides the idempotent "already" path.
//   - "x.y.z": an exact version match satisfies regardless of floors — the
//     caller asked for precisely what is installed.
//   - "" (ensure): satisfied when the install is present, probes cleanly, and
//     meets the descriptor floor — newer releases are left to explicit upgrades.
//   - "latest": satisfied only when no newer managed release is discoverable.
func installSatisfied(installedVersion string, minVersion string, requestedVersion string, latest func() string) bool {
	if installedVersion == "" {
		return false
	}
	if requestedVersion != "" && requestedVersion != "latest" {
		comparison, ok := managednpm.CompareStableVersions(installedVersion, requestedVersion)
		return ok && comparison == 0
	}
	if minVersion != "" {
		if comparison, ok := managednpm.CompareStableVersions(installedVersion, minVersion); ok && comparison < 0 {
			return false
		}
	}
	if requestedVersion == "" {
		return true
	}
	latestVersion := latest()
	if latestVersion == "" {
		return true
	}
	comparison, ok := managednpm.CompareStableVersions(installedVersion, latestVersion)
	return ok && comparison >= 0
}

func installable(install providerregistry.InstallerDescriptor) bool {
	switch install.Kind {
	case providerregistry.InstallerKindManagedNPM, providerregistry.InstallerKindCodexCLILatest:
		return strings.TrimSpace(install.PackageName) != ""
	case providerregistry.InstallerKindOfficialScript:
		return strings.TrimSpace(install.ScriptURL) != "" || strings.TrimSpace(install.DisplayCommand) != ""
	default:
		return false
	}
}

func findProviderTarget(providerID string) (providerregistry.ProviderDescriptor, bool) {
	for _, descriptor := range knownProviderTargets() {
		if normalizeProviderID(descriptor.Identity.ID) == normalizeProviderID(providerID) {
			return descriptor, true
		}
	}
	return providerregistry.ProviderDescriptor{}, false
}

func normalizeProviderID(value string) string {
	return strings.ToLower(strings.TrimSpace(value))
}

func (o *providerOps) acquireInstall(providerID string) bool {
	key := normalizeProviderID(providerID)
	o.installMu.Lock()
	defer o.installMu.Unlock()
	if o.installing[key] {
		return false
	}
	o.installing[key] = true
	return true
}

func (o *providerOps) releaseInstall(providerID string) {
	key := normalizeProviderID(providerID)
	o.installMu.Lock()
	delete(o.installing, key)
	o.installMu.Unlock()
}

func (o *providerOps) isInstallInProgress(providerID string) bool {
	key := normalizeProviderID(providerID)
	o.installMu.Lock()
	defer o.installMu.Unlock()
	return o.installing[key]
}

// selectInstallRegistry ranks the candidate registries and returns the first
// reachable one. A pinned override registry short-circuits ranking.
func (o *providerOps) selectInstallRegistry(ctx context.Context, install providerregistry.InstallerDescriptor) (string, error) {
	registries := managednpm.DefaultRegistries(envValueLast(o.environ(), managednpm.RegistryOverrideEnv))
	probeCtx, cancel := context.WithTimeout(ctx, 30*time.Second)
	defer cancel()
	ranked := managednpm.RankRegistries(probeCtx, managednpm.Descriptor{
		PackageName: install.PackageName, BinaryName: install.BinaryName,
		RecommendedVersion: install.RecommendedVersion, IncludeOptional: install.IncludeOptional,
	}, registries, runtime.GOOS, runtime.GOARCH, npmRegistryProber{client: o.httpClient})
	for _, candidate := range ranked {
		if candidate.Probe.Reachable && candidate.Probe.Complete {
			return candidate.Registry.URL, nil
		}
	}
	return "", errors.New("no reachable npm registry for provider install")
}

// installPrefix returns the npm global prefix that owns the user-managed
// launcher directory the resolver searches first.
func (o *providerOps) installPrefix() (string, error) {
	home, err := o.homeDir()
	if err != nil || strings.TrimSpace(home) == "" {
		return "", fmt.Errorf("resolve user home for managed npm prefix: %w", err)
	}
	dirs := runtimecmd.UserManagedNPMExecutableDirs(home)
	if len(dirs) == 0 {
		return "", errors.New("no user-managed npm executable directory")
	}
	return runtimecmd.ResolveNPMGlobalLayout(dirs[0]).PrefixDir, nil
}

// runInstallCommand executes the managed npm install with the selected
// registry pinned through npm_config_registry (env transport, no config-file
// writes, no shell string).
func (o *providerOps) runInstallCommand(ctx context.Context, command []string, registry string) (string, error) {
	if len(command) == 0 {
		return "", errors.New("empty install command")
	}
	npmCmd := newProviderExecCommand(ctx, command[0], command[1:]...)
	npmCmd.Env = withNPMRegistryEnv(o.environ(), registry)
	output, err := npmCmd.CombinedOutput()
	if errors.Is(ctx.Err(), context.DeadlineExceeded) {
		return string(output), fmt.Errorf("timed out after %s", providerInstallTimeout)
	}
	if err != nil {
		return string(output), err
	}
	return string(output), nil
}

func withNPMRegistryEnv(env []string, registry string) []string {
	const prefix = "npm_config_registry="
	result := make([]string, 0, len(env)+1)
	seen := false
	for _, item := range env {
		if key, _, ok := strings.Cut(item, "="); ok && strings.EqualFold(key, "npm_config_registry") {
			if !seen {
				result = append(result, prefix+registry)
				seen = true
			}
			continue
		}
		result = append(result, item)
	}
	if !seen {
		result = append(result, prefix+registry)
	}
	return result
}

func envValueLast(env []string, key string) string {
	value := ""
	for i := len(env) - 1; i >= 0; i-- {
		candidateKey, candidate, ok := strings.Cut(env[i], "=")
		if ok && strings.EqualFold(candidateKey, key) {
			value = candidate
			break
		}
	}
	return value
}

// tailLines returns the last n non-empty trimmed lines of output for compact
// error reporting.
func tailLines(output string, n int) string {
	lines := []string{}
	for _, line := range strings.Split(output, "\n") {
		if trimmed := strings.TrimSpace(line); trimmed != "" {
			lines = append(lines, trimmed)
		}
	}
	if len(lines) > n {
		lines = lines[len(lines)-n:]
	}
	return strings.Join(lines, " | ")
}

// cleanupNPMStagingDirs removes the sibling `.<package>-<hash>` staging
// directories npm leaves behind when a global install is interrupted, so the
// next attempt does not fail with ENOTEMPTY. Only the target package's
// staging dirs are removed; the global prefix may hold unrelated packages.
// Ported from Agorax's managed npm installer.
func cleanupNPMStagingDirs(prefixDir string, packageName string) {
	packageDir := managedNPMGlobalPackageDir(prefixDir, packageName)
	if packageDir == "" {
		return
	}
	parentDir := filepath.Dir(packageDir)
	stagingPrefix := "." + filepath.Base(packageDir) + "-"
	entries, err := os.ReadDir(parentDir)
	if err != nil {
		return
	}
	for _, entry := range entries {
		if !strings.HasPrefix(entry.Name(), stagingPrefix) {
			continue
		}
		_ = os.RemoveAll(filepath.Join(parentDir, entry.Name()))
	}
}

// managedNPMGlobalPackageDir maps an npm package name onto its directory
// inside an npm global prefix (scope-aware). It returns "" for names that are
// not safe single path segments.
func managedNPMGlobalPackageDir(prefixDir string, packageName string) string {
	if strings.TrimSpace(prefixDir) == "" || strings.TrimSpace(packageName) == "" {
		return ""
	}
	parts := strings.Split(filepath.ToSlash(packageName), "/")
	for _, part := range parts {
		if part == "" || part == "." || part == ".." || strings.ContainsAny(part, `/\`) {
			return ""
		}
	}
	return filepath.Join(append([]string{prefixDir, "lib", "node_modules"}, parts...)...)
}

func (o *providerOps) handleProviderLogin(response http.ResponseWriter, request *http.Request) {
	providerID := strings.TrimSpace(request.PathValue("provider"))
	var body struct {
		PreferWebTerminal *bool `json:"preferWebTerminal"`
	}
	_ = json.NewDecoder(request.Body).Decode(&body)
	preferWeb := true
	if body.PreferWebTerminal != nil {
		preferWeb = *body.PreferWebTerminal
	}
	result, status, err := o.startProviderLogin(context.WithoutCancel(request.Context()), providerID, preferWeb)
	if err != nil {
		writeJSON(response, status, map[string]string{"error": err.Error()})
		return
	}
	writeJSON(response, status, result)
}
