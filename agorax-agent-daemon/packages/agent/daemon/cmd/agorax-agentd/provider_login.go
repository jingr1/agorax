package main

import (
	"context"
	"fmt"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"time"

	"agorax.local/agent-daemon/packages/agent/daemon/providerregistry"
	"agorax.local/agent-daemon/packages/agent/daemon/providerstatus"
)

const (
	// providerLoginWatchTimeout bounds how long status reports loginInProgress
	// after the daemon launches an interactive login process.
	providerLoginWatchTimeout = 3 * time.Minute
	// providerLoginPollInterval is how often we re-probe auth while watching.
	providerLoginPollInterval = 5 * time.Second
)

type providerLoginResultDTO struct {
	Provider       string   `json:"provider"`
	Status         string   `json:"status"` // "started" | "already" | "in_progress"
	Mode           string   `json:"mode,omitempty"` // "terminal" | "detached" | "command"
	Command        []string `json:"command,omitempty"`
	DisplayCommand string   `json:"displayCommand,omitempty"`
}

func loginDescriptorDTO(status providerregistry.StatusDescriptor, binary string) (*providerLoginDTO, bool) {
	if len(status.LoginArgs) == 0 {
		return nil, false
	}
	commandName := strings.TrimSpace(binary)
	if commandName == "" && len(status.BinaryNames) > 0 {
		commandName = status.BinaryNames[0]
	}
	if commandName == "" {
		return nil, false
	}
	parts := append([]string{commandName}, status.LoginArgs...)
	return &providerLoginDTO{
		Supported:      true,
		DisplayCommand: strings.Join(parts, " "),
		Command:        parts,
	}, true
}

func (o *providerOps) acquireLogin(providerID string) (epoch uint64, ok bool) {
	key := normalizeProviderID(providerID)
	o.loginMu.Lock()
	defer o.loginMu.Unlock()
	if o.loggingIn[key] {
		return 0, false
	}
	o.loginEpoch++
	epoch = o.loginEpoch
	o.loggingIn[key] = true
	return epoch, true
}

func (o *providerOps) releaseLogin(providerID string, epoch uint64) {
	key := normalizeProviderID(providerID)
	o.loginMu.Lock()
	defer o.loginMu.Unlock()
	if epoch != 0 && o.loginEpoch != epoch {
		// A newer login or ForceRefresh cancelled this watch.
		return
	}
	delete(o.loggingIn, key)
}

func (o *providerOps) isLoginInProgress(providerID string) bool {
	key := normalizeProviderID(providerID)
	o.loginMu.Lock()
	defer o.loginMu.Unlock()
	return o.loggingIn[key]
}

// clearLoginProgress cancels every in-flight login watch. Called from
// ForceRefresh (Settings → 重新检测) so a closed web terminal cannot leave
// loginInProgress=true and hide the Login remediation.
func (o *providerOps) clearLoginProgress() {
	o.loginMu.Lock()
	defer o.loginMu.Unlock()
	o.loginEpoch++
	o.loggingIn = map[string]bool{}
}

// startProviderLogin launches the provider's interactive login CLI, or returns
// a command for the Agorax web terminal when preferWebTerminal is set / the
// host is headless. The handler returns immediately; a background watcher
// clears loginInProgress when auth becomes ready or the watch budget expires.
func (o *providerOps) startProviderLogin(ctx context.Context, providerID string, preferWebTerminal bool) (providerLoginResultDTO, int, error) {
	result := providerLoginResultDTO{Provider: providerID}
	descriptor, ok := findProviderTarget(providerID)
	if !ok {
		return result, http.StatusNotFound, fmt.Errorf("unknown provider %q", providerID)
	}
	if len(descriptor.Status.LoginArgs) == 0 {
		return result, http.StatusUnprocessableEntity, fmt.Errorf("interactive login is not supported for %q", providerID)
	}

	binary := o.resolveBinary(descriptor.Status.BinaryNames)
	if binary == "" {
		return result, http.StatusBadRequest, fmt.Errorf("%q is not installed", providerID)
	}

	// Already authenticated — no need to relaunch.
	if auth := o.probeAuthQuick(ctx, descriptor, binary); auth == providerstatus.AuthAuthenticated || auth == providerstatus.AuthConfigured {
		result.Status = "already"
		if login, ok := loginDescriptorDTO(descriptor.Status, binary); ok {
			result.DisplayCommand = login.DisplayCommand
			result.Command = login.Command
		}
		return result, http.StatusOK, nil
	}

	epoch, acquired := o.acquireLogin(providerID)
	if !acquired {
		result.Status = "in_progress"
		return result, http.StatusConflict, fmt.Errorf("a login for %q is already in progress", providerID)
	}

	loginArgs := append([]string{}, descriptor.Status.LoginArgs...)
	// Agorax web PTY / SSH / headless hosts cannot complete Codex's default
	// localhost:1455 OAuth callback — the browser runs on the operator's
	// laptop while `codex login` listens on the remote. Prefer device-auth
	// so the terminal shows a URL + user code instead of a dead 127.0.0.1 link.
	useWebOrHeadless := preferWebTerminal || !loginPrefersTerminalEmulator(o.environ())
	if useWebOrHeadless && normalizeProviderID(providerID) == "codex" {
		loginArgs = withCodexDeviceAuthLoginArgs(loginArgs)
	}
	direct := append([]string{binary}, loginArgs...)
	// Browser / remote Agorax clients open the built-in web PTY themselves.
	if useWebOrHeadless {
		result.Status = "started"
		result.Mode = "command"
		result.Command = direct
		result.DisplayCommand = strings.Join(direct, " ")
		go o.watchProviderLogin(providerID, descriptor, epoch)
		return result, http.StatusOK, nil
	}

	mode, command, err := o.launchInteractiveLogin(binary, loginArgs)
	if err != nil {
		o.releaseLogin(providerID, epoch)
		return result, http.StatusInternalServerError, err
	}
	result.Status = "started"
	result.Mode = mode
	result.Command = command
	result.DisplayCommand = strings.Join(command, " ")

	go o.watchProviderLogin(providerID, descriptor, epoch)
	return result, http.StatusOK, nil
}

func (o *providerOps) probeAuthQuick(ctx context.Context, descriptor providerregistry.ProviderDescriptor, binary string) providerstatus.AuthStatus {
	status := descriptor.Status
	if len(status.AuthStatusCommand) == 0 {
		if auth, ok := o.probeAuthFromMarkers(status); ok {
			return auth
		}
		if len(status.AuthMarkerPaths) > 0 {
			return providerstatus.AuthRequired
		}
		return providerstatus.AuthUnknown
	}
	timeout := time.Duration(status.AuthStatusCommandTimeoutSeconds) * time.Second
	if timeout <= 0 || timeout > providerAuthTimeoutMax {
		timeout = providerAuthTimeoutMax
	}
	output, err := o.runProviderCommand(ctx, timeout, binary, status.AuthStatusCommand...)
	if err != nil {
		return providerstatus.AuthUnknown
	}
	auth, ok := providerstatus.ParseAuthStatusOutput(status.AuthOutputParserKind, output)
	if !ok {
		return providerstatus.AuthUnknown
	}
	return auth.Status
}

// probeAuthFromMarkers returns authenticated when any declared credential
// marker file exists (file_exists parser). Used by host-only stubs such as
// kimi-code that have no AuthStatusCommand yet.
func (o *providerOps) probeAuthFromMarkers(status providerregistry.StatusDescriptor) (providerstatus.AuthStatus, bool) {
	if len(status.AuthMarkerPaths) == 0 {
		return "", false
	}
	if status.AuthMarkerParserKind != "" &&
		status.AuthMarkerParserKind != providerregistry.AuthMarkerParserKindFileExists {
		return "", false
	}
	home, err := o.homeDir()
	if err != nil || strings.TrimSpace(home) == "" {
		return "", false
	}
	for _, marker := range status.AuthMarkerPaths {
		marker = strings.TrimSpace(marker)
		if marker == "" {
			continue
		}
		path := expandUserHomePath(marker, home)
		info, statErr := os.Stat(path)
		if statErr != nil || info.IsDir() {
			continue
		}
		return providerstatus.AuthAuthenticated, true
	}
	return "", false
}

func expandUserHomePath(path string, home string) string {
	path = strings.TrimSpace(path)
	if path == "~" {
		return home
	}
	if strings.HasPrefix(path, "~/") {
		return filepath.Join(home, path[2:])
	}
	return path
}

func (o *providerOps) watchProviderLogin(providerID string, descriptor providerregistry.ProviderDescriptor, epoch uint64) {
	defer o.releaseLogin(providerID, epoch)
	deadline := o.now().Add(providerLoginWatchTimeout)
	// Probe immediately: web-terminal logins often finish (and write auth
	// markers) before the first 5s sleep would have fired; status polls can
	// already report authenticated while loginInProgress is still held.
	for {
		if !o.loginEpochMatches(providerID, epoch) {
			return
		}
		binary := o.resolveBinary(descriptor.Status.BinaryNames)
		if binary != "" {
			auth := o.probeAuthQuick(context.Background(), descriptor, binary)
			if auth == providerstatus.AuthAuthenticated || auth == providerstatus.AuthConfigured {
				return
			}
		}
		if !o.now().Before(deadline) {
			return
		}
		time.Sleep(providerLoginPollInterval)
	}
}

func (o *providerOps) loginEpochMatches(providerID string, epoch uint64) bool {
	key := normalizeProviderID(providerID)
	o.loginMu.Lock()
	defer o.loginMu.Unlock()
	return o.loggingIn[key] && o.loginEpoch == epoch
}

// launchInteractiveLogin prefers a terminal emulator so TTY-based login CLIs
// work on graphical hosts. Headless / SSH / browser-remote hosts (no DISPLAY)
// return mode "command" without spawning a GUI terminal the user cannot see.
// Detached process launch remains the fallback when a graphical session exists
// but no terminal emulator is available (typical for OAuth browser flows).
func (o *providerOps) launchInteractiveLogin(binary string, loginArgs []string) (mode string, command []string, err error) {
	direct := append([]string{binary}, loginArgs...)
	if !loginPrefersTerminalEmulator(o.environ()) {
		// Do not spawn gnome-terminal/xterm on a machine the user only reaches
		// through a remote browser — they would never see the window. The UI
		// copies DisplayCommand into the user's own SSH / web terminal.
		return "command", direct, nil
	}
	if terminalCmd, ok := buildLoginTerminalCommand(binary, loginArgs, o.environ()); ok {
		cmd := exec.Command(terminalCmd[0], terminalCmd[1:]...)
		cmd.Env = o.environ()
		detachProviderProcess(cmd)
		if startErr := cmd.Start(); startErr != nil {
			// Fall through to detached direct launch.
		} else {
			go func() { _ = cmd.Wait() }()
			return "terminal", direct, nil
		}
	}

	cmd := newProviderExecCommand(context.Background(), binary, loginArgs...)
	cmd.Env = o.environ()
	cmd.Stdin = nil
	cmd.Stdout = os.Stdout
	cmd.Stderr = os.Stderr
	detachProviderProcess(cmd)
	if err := cmd.Start(); err != nil {
		return "", nil, fmt.Errorf("failed to start login process: %w", err)
	}
	go func() { _ = cmd.Wait() }()
	return "detached", direct, nil
}

// withCodexDeviceAuthLoginArgs inserts `--device-auth` after the `login`
// subcommand when missing. Device auth prints a URL + code in the terminal
// instead of binding http://127.0.0.1:1455 for a browser redirect.
func withCodexDeviceAuthLoginArgs(args []string) []string {
	if len(args) == 0 {
		return []string{"login", "--device-auth"}
	}
	for _, arg := range args {
		if arg == "--device-auth" {
			return append([]string{}, args...)
		}
	}
	out := make([]string, 0, len(args)+1)
	inserted := false
	for _, arg := range args {
		out = append(out, arg)
		if !inserted && arg == "login" {
			out = append(out, "--device-auth")
			inserted = true
		}
	}
	if !inserted {
		out = append([]string{"login", "--device-auth"}, args...)
	}
	return out
}

// loginPrefersTerminalEmulator is true only when this daemon process has a
// graphical session. Remote SSH / headless hosts must not open local GUI
// terminals. Override with AGORAX_LOGIN_HEADLESS=1 (force command) or
// AGORAX_LOGIN_TERMINAL=<bin> (force a specific emulator).
func loginPrefersTerminalEmulator(environ []string) bool {
	if strings.TrimSpace(envValueLast(environ, "AGORAX_LOGIN_HEADLESS")) == "1" {
		return false
	}
	if strings.TrimSpace(envValueLast(environ, "AGORAX_LOGIN_TERMINAL")) != "" {
		return true
	}
	display := strings.TrimSpace(envValueLast(environ, "DISPLAY"))
	wayland := strings.TrimSpace(envValueLast(environ, "WAYLAND_DISPLAY"))
	return display != "" || wayland != ""
}
