//go:build windows

package agentstatus

import (
	"path/filepath"
	"strings"
)

const managedPosixShellInstallerEnv = "AGORAX_MANAGED_POSIX_SHELL"

// officialScriptInvocation keeps the provider registry portable: providers
// describe their official Unix installer shell (bash/sh), while Windows runs
// that same downloaded script through the vendored MSYS2 shell. This is the
// same shell contract used by workspace app bootstrap.sh files and packaged
// desktop builds inject the absolute path into the daemon environment.
func officialScriptInvocation(scriptShell string, scriptPath string, env []string) (string, []string, []string) {
	shell := strings.TrimSpace(scriptShell)
	args := []string{shell, scriptPath}
	if isPOSIXInstallerShell(shell) {
		if managed := installerEnvValue(env, managedPosixShellInstallerEnv); managed != "" {
			shell = managed
			args = []string{shell, "--noprofile", "--norc", scriptPath}
			env = setInstallerEnvValue(env, "MSYS2_PATH_TYPE", "inherit")
		}
	}
	return joinShellCommand(args), args, env
}

func isPOSIXInstallerShell(shell string) bool {
	base := strings.ToLower(filepath.Base(strings.ReplaceAll(strings.TrimSpace(shell), "\\", "/")))
	return base == "bash" || base == "bash.exe" || base == "sh" || base == "sh.exe" || base == "zsh" || base == "zsh.exe"
}
