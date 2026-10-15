//go:build windows

package main

import (
	"os/exec"
	"strings"
	"syscall"

	"golang.org/x/sys/windows"
)

func detachProviderProcess(cmd *exec.Cmd) {
	flags := uint32(windows.CREATE_NEW_PROCESS_GROUP | windows.CREATE_NEW_CONSOLE)
	if cmd.SysProcAttr == nil {
		cmd.SysProcAttr = &syscall.SysProcAttr{}
	}
	cmd.SysProcAttr.CreationFlags |= flags
}

// buildLoginTerminalCommand opens an interactive console for Windows login CLIs.
func buildLoginTerminalCommand(binary string, loginArgs []string, environ []string) ([]string, bool) {
	if override := strings.TrimSpace(envValueLast(environ, "AGORAX_LOGIN_TERMINAL")); override != "" {
		return append([]string{override}, append([]string{binary}, loginArgs...)...), true
	}
	// wt.exe (Windows Terminal) when present; otherwise create a new console via
	// detached CREATE_NEW_CONSOLE on the direct launch path.
	if path, err := exec.LookPath("wt.exe"); err == nil {
		args := append([]string{"new-tab", binary}, loginArgs...)
		return append([]string{path}, args...), true
	}
	if path, err := exec.LookPath("cmd.exe"); err == nil {
		joined := strings.Join(append([]string{binary}, loginArgs...), " ")
		return []string{path, "/c", "start", "Agorax Login", "cmd.exe", "/k", joined}, true
	}
	return nil, false
}
