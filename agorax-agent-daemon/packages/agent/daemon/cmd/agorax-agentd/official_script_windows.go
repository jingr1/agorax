//go:build windows

package main

import (
	"path/filepath"
	"strings"
)

// officialScriptArgv keeps the provider registry portable: providers describe
// their official Unix installer shell (bash/sh). On native Windows the
// PowerShell fallback path owns Cursor; this helper is for any Unix-script
// Windows path that still lands here (e.g. managed POSIX shell).
func officialScriptArgv(scriptShell string, scriptPath string) []string {
	shell := strings.TrimSpace(scriptShell)
	if shell == "" {
		shell = "bash"
	}
	base := strings.ToLower(filepath.Base(strings.ReplaceAll(shell, "\\", "/")))
	switch base {
	case "bash", "bash.exe", "sh", "sh.exe", "zsh", "zsh.exe":
		return []string{shell, "--noprofile", "--norc", scriptPath}
	default:
		return []string{shell, scriptPath}
	}
}
