package main

import (
	"context"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"runtime"
	"strings"

	"agorax.local/agent-daemon/packages/agent/daemon/providerregistry"
)

// installOfficialScript assumes the install lock is held and the "already
// satisfied" short-circuit has been checked. Unix downloads ScriptURL and runs
// it through ScriptShell; Windows uses the descriptor's WindowsFallback
// (PowerShell command or managed-npm package).
func (o *providerOps) installOfficialScript(
	ctx context.Context,
	result providerInstallResultDTO,
	descriptor providerregistry.ProviderDescriptor,
	requestedVersion string,
) (providerInstallResultDTO, int, error) {
	install := descriptor.Status.Install
	installCtx, cancel := context.WithTimeout(ctx, providerInstallTimeout)
	defer cancel()

	var (
		command       []string
		commandOutput string
		runErr        error
	)

	if runtime.GOOS == "windows" {
		switch install.WindowsFallback {
		case providerregistry.InstallerWindowsFallbackPowerShell:
			psCommand := strings.TrimSpace(install.WindowsPowerShellCommand)
			if psCommand == "" {
				return result, http.StatusUnprocessableEntity, errors.New("Windows PowerShell installer command is missing")
			}
			command = []string{
				"powershell.exe",
				"-NoLogo",
				"-NoProfile",
				"-NonInteractive",
				"-ExecutionPolicy",
				"Bypass",
				"-Command",
				psCommand,
			}
			result.Command = command
			commandOutput, runErr = o.runArgvInstallCommand(installCtx, command)
		case providerregistry.InstallerWindowsFallbackManagedNPM:
			if strings.TrimSpace(install.PackageName) == "" {
				return result, http.StatusUnprocessableEntity, errors.New("Windows managed npm fallback is missing its package configuration")
			}
			return o.installManagedNPM(ctx, result, descriptor, requestedVersion)
		default:
			return result, http.StatusUnprocessableEntity, errors.New(
				"this provider's official installer is Unix-only and cannot run on native Windows; install the CLI in WSL or provide an existing native CLI",
			)
		}
	} else {
		scriptURL := strings.TrimSpace(install.ScriptURL)
		if scriptURL == "" {
			return result, http.StatusUnprocessableEntity, errors.New("official installer script URL is missing")
		}
		scriptShell := strings.TrimSpace(install.ScriptShell)
		if scriptShell == "" {
			scriptShell = "bash"
		}
		installerFile, err := os.CreateTemp("", "agorax-provider-install-*.sh")
		if err != nil {
			return result, http.StatusInternalServerError, err
		}
		scriptPath := installerFile.Name()
		defer func() { _ = os.Remove(scriptPath) }()
		if err := installerFile.Close(); err != nil {
			return result, http.StatusInternalServerError, err
		}
		if err := o.downloadInstallScript(installCtx, scriptURL, scriptPath); err != nil {
			return result, http.StatusBadGateway, err
		}
		if err := os.Chmod(scriptPath, 0o700); err != nil {
			return result, http.StatusInternalServerError, err
		}
		command = officialScriptArgv(scriptShell, scriptPath)
		result.Command = []string{scriptShell, scriptURL}
		env := o.environ()
		if pinned, err := o.officialScriptPinnedVersion(installCtx, install, requestedVersion); err != nil {
			return result, http.StatusBadGateway, err
		} else if pinned != "" {
			env = setProviderInstallEnv(env, "VERSION", pinned)
			result.Command = append(result.Command, "--version", pinned)
		}
		commandOutput, runErr = o.runArgvInstallCommandWithEnv(installCtx, command, env)
	}

	if runErr != nil {
		return result, http.StatusInternalServerError, fmt.Errorf(
			"official script install failed: %w (%s)",
			runErr,
			tailLines(commandOutput, installLogTailLines),
		)
	}

	installed := o.resolveBinary(descriptor.Status.BinaryNames)
	if installed == "" {
		name := "binary"
		if len(descriptor.Status.BinaryNames) > 0 {
			name = descriptor.Status.BinaryNames[0]
		}
		return result, http.StatusInternalServerError, fmt.Errorf(
			"official script install completed but %q is still not resolvable on PATH",
			name,
		)
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

func (o *providerOps) runArgvInstallCommand(ctx context.Context, command []string) (string, error) {
	return o.runArgvInstallCommandWithEnv(ctx, command, o.environ())
}

func (o *providerOps) runArgvInstallCommandWithEnv(ctx context.Context, command []string, env []string) (string, error) {
	if len(command) == 0 {
		return "", errors.New("empty install command")
	}
	cmd := newProviderExecCommand(ctx, command[0], command[1:]...)
	if env != nil {
		cmd.Env = env
	} else {
		cmd.Env = o.environ()
	}
	output, err := cmd.CombinedOutput()
	if errors.Is(ctx.Err(), context.DeadlineExceeded) {
		return string(output), fmt.Errorf("timed out after %s", providerInstallTimeout)
	}
	if err != nil {
		return string(output), err
	}
	return string(output), nil
}

// officialScriptPinnedVersion resolves VERSION for official installers that
// declare an npm PackageName. OpenCode's install.sh otherwise hits
// api.github.com for latest and fails under unauthenticated rate limits.
func (o *providerOps) officialScriptPinnedVersion(
	ctx context.Context,
	install providerregistry.InstallerDescriptor,
	requestedVersion string,
) (string, error) {
	requestedVersion = strings.TrimSpace(requestedVersion)
	if requestedVersion != "" && requestedVersion != "latest" {
		return strings.TrimPrefix(requestedVersion, "v"), nil
	}
	packageName := strings.TrimSpace(install.PackageName)
	if packageName == "" {
		return "", nil
	}
	if existing := strings.TrimSpace(envValueLast(o.environ(), "VERSION")); existing != "" {
		return strings.TrimPrefix(existing, "v"), nil
	}
	version := strings.TrimSpace(o.latestVersion(ctx, packageName))
	if version == "" {
		return "", fmt.Errorf(
			"failed to resolve %s install version via npm (avoids GitHub API rate limits)",
			packageName,
		)
	}
	return strings.TrimPrefix(version, "v"), nil
}

func setProviderInstallEnv(env []string, key string, value string) []string {
	prefix := key + "="
	result := make([]string, 0, len(env)+1)
	set := false
	for _, entry := range env {
		if strings.HasPrefix(entry, prefix) {
			if !set {
				result = append(result, prefix+value)
				set = true
			}
			continue
		}
		result = append(result, entry)
	}
	if !set {
		result = append(result, prefix+value)
	}
	return result
}

func (o *providerOps) downloadInstallScript(ctx context.Context, sourceURL, destinationPath string) error {
	// Do not reuse the registry-probe httpClient: its timeout is seconds, while
	// official installer scripts and redirects routinely need minutes.
	client := &http.Client{Timeout: providerScriptDownloadTimeout}
	var lastErr error
	for attempt := 1; attempt <= providerScriptDownloadAttempts; attempt++ {
		attemptCtx, cancel := context.WithTimeout(ctx, providerScriptDownloadTimeout)
		err := downloadFileOnce(attemptCtx, client, sourceURL, destinationPath)
		cancel()
		if err == nil {
			return nil
		}
		lastErr = err
		if attempt == providerScriptDownloadAttempts || !isRetryableDownloadError(err) {
			return err
		}
	}
	return lastErr
}

func downloadFileOnce(ctx context.Context, client *http.Client, sourceURL, destinationPath string) error {
	request, err := http.NewRequestWithContext(ctx, http.MethodGet, sourceURL, nil)
	if err != nil {
		return fmt.Errorf("create download request: %w", err)
	}
	response, err := client.Do(request)
	if err != nil {
		return fmt.Errorf("download %s: %w", sourceURL, err)
	}
	defer response.Body.Close()
	if response.StatusCode < 200 || response.StatusCode >= 300 {
		_, _ = io.Copy(io.Discard, io.LimitReader(response.Body, 64*1024))
		return downloadStatusError{URL: sourceURL, StatusCode: response.StatusCode}
	}
	if err := os.MkdirAll(filepath.Dir(destinationPath), 0o755); err != nil {
		return fmt.Errorf("create download parent: %w", err)
	}
	target, err := os.OpenFile(destinationPath, os.O_WRONLY|os.O_CREATE|os.O_TRUNC, 0o644)
	if err != nil {
		return fmt.Errorf("create download destination: %w", err)
	}
	_, copyErr := io.Copy(target, response.Body)
	closeErr := target.Close()
	return errors.Join(copyErr, closeErr)
}

type downloadStatusError struct {
	URL        string
	StatusCode int
}

func (e downloadStatusError) Error() string {
	return fmt.Sprintf("download %s: unexpected status %d", e.URL, e.StatusCode)
}

func isRetryableDownloadError(err error) bool {
	if err == nil || errors.Is(err, context.Canceled) || errors.Is(err, context.DeadlineExceeded) {
		return false
	}
	var statusErr downloadStatusError
	if errors.As(err, &statusErr) {
		return statusErr.StatusCode == http.StatusRequestTimeout ||
			statusErr.StatusCode == http.StatusTooManyRequests ||
			statusErr.StatusCode >= 500
	}
	if errors.Is(err, io.EOF) || errors.Is(err, io.ErrUnexpectedEOF) {
		return true
	}
	var netErr net.Error
	if errors.As(err, &netErr) {
		return netErr.Timeout()
	}
	return false
}
