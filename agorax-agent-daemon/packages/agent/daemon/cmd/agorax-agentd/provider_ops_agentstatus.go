package main

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"time"

	"agorax.local/agent-daemon/packages/agent/daemon/agentstatus"
	"agorax.local/agent-daemon/packages/agent/daemon/managedruntime"
	"agorax.local/agent-daemon/packages/agent/daemon/providerregistry"
	agoraxstate "agorax.local/agent-daemon/packages/agent/daemon/agoraxstate"
)

// newAgentStatusService constructs Agorax's agentstatus.Service so detect /
// install / update discovery reuse Agorax's implementation instead of a
// parallel Agorax-only installer.
func newAgentStatusService(environ func() []string, homeDir func() (string, error)) agentstatus.Service {
	if environ == nil {
		environ = os.Environ
	}
	if homeDir == nil {
		homeDir = os.UserHomeDir
	}
	home, _ := homeDir()
	claudeRuntime := filepath.Join(home, ".local", "share", "agorax", "claude-code")
	if state := strings.TrimSpace(agoraxstate.DefaultStateDir()); state != "" {
		claudeRuntime = filepath.Join(state, "claude-code-runtime")
	}
	service := agentstatus.NewService(agentstatus.ServiceDependencies{
		ManagedRuntime:       managedruntime.DefaultResolver{},
		ClaudeCodeRuntimeDir: claudeRuntime,
		UserCommandBinDir:    filepath.Join(home, ".local", "bin"),
	})
	service.Environ = environ
	service.HomeDir = homeDir
	service.Now = time.Now
	return service
}

func (o *providerOps) agentStatus() agentstatus.Service {
	if o.statusService == nil {
		svc := newAgentStatusService(o.environ, o.homeDir)
		o.statusService = &svc
	}
	return *o.statusService
}

func (o *providerOps) handleProviderStatus(response http.ResponseWriter, request *http.Request) {
	// Only probe Agorax-backed providers. Full agentstatus DefaultRegistry may
	// still contain unsupported stubs (Nexight / OpenClaw) we must not install.
	listProviders := make([]string, 0, 4)
	for _, descriptor := range knownProviderTargets() {
		id := normalizeProviderID(descriptor.Identity.ID)
		if id == "" || id == "kimi-code" {
			continue
		}
		listProviders = append(listProviders, id)
	}
	// Interactive「重新检测」passes refresh=1 so we bypass the 30m readiness
	// cache and re-resolve CLIs (avoids ghost "installed" after a shim/binary
	// was removed).
	forceRefresh := queryFlagTrue(request.URL.Query().Get("refresh")) ||
		queryFlagTrue(request.URL.Query().Get("forceRefresh"))
	if forceRefresh {
		// Drop stale loginInProgress so「重新检测」after a finished terminal
		// can surface Login again when auth is still required.
		o.clearLoginProgress()
	}
	snapshot, err := o.agentStatus().List(request.Context(), agentstatus.ListInput{
		Providers:      listProviders,
		IncludeUpdates: true,
		ForceRefresh:   forceRefresh,
		RefreshUpdates: forceRefresh,
	})
	if err != nil {
		writeJSON(response, http.StatusInternalServerError, map[string]string{"error": err.Error()})
		return
	}

	byProvider := make(map[string]agentstatus.ProviderStatus, len(snapshot.Providers))
	for _, entry := range snapshot.Providers {
		byProvider[normalizeProviderID(entry.Provider)] = entry
	}

	targets := knownProviderTargets()
	statuses := make([]providerStatusDTO, 0, len(targets))
	for _, descriptor := range targets {
		id := normalizeProviderID(descriptor.Identity.ID)
		if entry, ok := byProvider[id]; ok {
			statuses = append(statuses, mapAgentStatusToDTO(o, descriptor, entry))
			continue
		}
		// kimi-code and any host-only targets fall back to the thin detector.
		statuses = append(statuses, o.detectProvider(request.Context(), descriptor))
	}

	writeJSON(response, http.StatusOK, providerStatusListDTO{
		CapturedAt: snapshot.CapturedAt.UTC().Format(time.RFC3339),
		Providers:  statuses,
	})
}

func (o *providerOps) handleProviderInstall(response http.ResponseWriter, request *http.Request) {
	providerID := strings.TrimSpace(request.PathValue("provider"))
	if !isAgoraxManagedInstallProvider(providerID) {
		writeJSON(response, http.StatusUnprocessableEntity, map[string]string{
			"error": "provider is not installable via Agorax managed install",
		})
		return
	}
	var body struct {
		Version string `json:"version"`
	}
	if err := json.NewDecoder(request.Body).Decode(&body); err != nil && !errors.Is(err, io.EOF) {
		writeJSON(response, http.StatusBadRequest, map[string]string{"error": err.Error()})
		return
	}

	requestedVersion := strings.TrimSpace(body.Version)

	// Detach from the HTTP request lifetime (same as login): npm install /
	// update can take minutes; a closed browser tab must not cancel mid-write
	// and leave a half-linked global package.
	installCtx := context.WithoutCancel(request.Context())

	// kimi-code is a host-only stub (not in agentstatus DefaultRegistry yet).
	// Drive install through the descriptor-owned official_script path instead.
	if normalizeProviderID(providerID) == "kimi-code" {
		result, status, err := o.installProvider(installCtx, providerID, requestedVersion)
		if err != nil {
			writeJSON(response, status, map[string]string{"error": err.Error()})
			return
		}
		writeJSON(response, status, result)
		return
	}

	// Empty body → ActionInstall (ensure present). UI upgrade sends
	// version=latest (or a pin); ActionInstall short-circuits when the CLI
	// already probes ready, so those requests must use ActionUpdate or the
	// wizard flashes「升级中」then exits without running npm.
	actionID := agentstatus.ActionInstall
	if wantsProviderUpgrade(requestedVersion) {
		actionID = agentstatus.ActionUpdate
	}

	result, err := o.agentStatus().RunAction(installCtx, agentstatus.RunActionInput{
		Provider: providerID,
		ActionID: actionID,
	})
	if err != nil {
		status := http.StatusInternalServerError
		if errors.Is(err, agentstatus.ErrInvalidProvider) {
			status = http.StatusNotFound
		} else if errors.Is(err, agentstatus.ErrInvalidAction) {
			status = http.StatusUnprocessableEntity
		}
		writeJSON(response, status, map[string]string{"error": err.Error()})
		return
	}
	if result.Status == agentstatus.RunActionFailed {
		writeJSON(response, http.StatusInternalServerError, map[string]string{
			"error": firstNonEmpty(result.Message, result.ReasonCode, "install failed"),
		})
		return
	}

	dto := providerInstallResultDTO{
		Provider: result.Provider,
		Status:   "installed",
		Command:  splitCommand(result.Command),
	}
	if result.ReasonCode == "already_up_to_date" {
		dto.Status = "already"
	}
	if result.Probe != nil {
		if result.Probe.BinaryPath != "" {
			dto.BinaryPath = stringPointer(result.Probe.BinaryPath)
		}
		if version := strings.TrimSpace(cliVersionFromProbe(result.Probe)); version != "" {
			dto.Version = stringPointer(version)
		}
	}
	writeJSON(response, http.StatusOK, dto)
}

// wantsProviderUpgrade is true when POST /install carries an explicit version
// (UI upgrade uses "latest"). A bare ensure-install leaves version empty.
func wantsProviderUpgrade(version string) bool {
	return strings.TrimSpace(version) != ""
}

func mapAgentStatusToDTO(
	o *providerOps,
	descriptor providerregistry.ProviderDescriptor,
	entry agentstatus.ProviderStatus,
) providerStatusDTO {
	dto := providerStatusDTO{
		Provider:          entry.Provider,
		TargetID:          descriptor.Target.ID,
		Registered:        o.isRegistered(descriptor),
		Installed:         entry.CLI.Installed,
		InstallInProgress: entry.ActiveAction != nil &&
			(entry.ActiveAction.ID == agentstatus.ActionInstall ||
				entry.ActiveAction.ID == agentstatus.ActionUpdate),
		LoginInProgress:   o.isLoginInProgress(entry.Provider),
		MinVersion:        entry.CLI.MinVersion,
		Auth: providerAuthDTO{
			Status:       string(entry.Auth.Status),
			AccountLabel: stringPointerOrNil(entry.Auth.AccountLabel),
			AuthMethod:   stringPointerOrNil(entry.Auth.AuthMethod),
		},
		Update: providerUpdateDTO{
			Capability:        string(entry.Update.Capability),
			Source:            string(entry.Update.Source),
			UnsupportedReason: entry.Update.UnsupportedReason,
			ReasonCode:        entry.Update.ReasonCode,
		},
	}
	if entry.CLI.BinaryPath != "" {
		dto.BinaryPath = stringPointer(entry.CLI.BinaryPath)
	}
	if entry.CLI.Version != "" {
		dto.Version = stringPointer(entry.CLI.Version)
		dto.Update.CurrentVersion = stringPointer(entry.CLI.Version)
	}
	if entry.Update.LatestVersion != "" {
		dto.LatestVersion = stringPointer(entry.Update.LatestVersion)
		dto.Update.LatestVersion = stringPointer(entry.Update.LatestVersion)
	}
	if entry.Update.UpdateAvailable != nil {
		dto.UpdateAvailable = *entry.Update.UpdateAvailable
	}
	if entry.Update.LastCheckedAt != nil {
		formatted := entry.Update.LastCheckedAt.UTC().Format(time.RFC3339)
		dto.Update.LastCheckedAt = &formatted
	}
	if install, ok := installDescriptorDTO(descriptor.Status); ok {
		dto.Install = install
	}
	if login := loginDTOFromDescriptor(descriptor); login != nil {
		dto.Login = login
	}
	if entry.LastError != nil && strings.TrimSpace(entry.LastError.Message) != "" {
		dto.Error = entry.LastError.Message
	}
	return dto
}

func loginDTOFromDescriptor(descriptor providerregistry.ProviderDescriptor) *providerLoginDTO {
	args := descriptor.Status.LoginArgs
	if len(args) == 0 {
		return &providerLoginDTO{Supported: false}
	}
	binary := ""
	if len(descriptor.Status.BinaryNames) > 0 {
		binary = descriptor.Status.BinaryNames[0]
	}
	command := append([]string{binary}, args...)
	return &providerLoginDTO{
		Supported:      true,
		DisplayCommand: strings.Join(command, " "),
		Command:        command,
	}
}

func cliVersionFromProbe(probe *agentstatus.ProbeResult) string {
	if probe == nil {
		return ""
	}
	for _, check := range probe.Checks {
		if strings.EqualFold(check.Name, "version") && strings.TrimSpace(check.Detail) != "" {
			return strings.TrimSpace(check.Detail)
		}
	}
	return ""
}

func splitCommand(command string) []string {
	command = strings.TrimSpace(command)
	if command == "" {
		return nil
	}
	return strings.Fields(command)
}

func isAgoraxManagedInstallProvider(providerID string) bool {
	switch normalizeProviderID(providerID) {
	case providerregistry.CodexProviderID,
		providerregistry.ClaudeCodeProviderID,
		providerregistry.CursorProviderID,
		providerregistry.OpenCodeProviderID,
		"kimi-code":
		return true
	default:
		return false
	}
}

func stringPointerOrNil(value string) *string {
	value = strings.TrimSpace(value)
	if value == "" {
		return nil
	}
	return &value
}

func queryFlagTrue(raw string) bool {
	switch strings.ToLower(strings.TrimSpace(raw)) {
	case "1", "true", "yes", "on":
		return true
	default:
		return false
	}
}

func firstNonEmpty(values ...string) string {
	for _, value := range values {
		if strings.TrimSpace(value) != "" {
			return strings.TrimSpace(value)
		}
	}
	return ""
}
