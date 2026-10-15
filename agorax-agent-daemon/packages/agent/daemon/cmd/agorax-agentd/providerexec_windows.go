//go:build windows

package main

import (
	"context"
	"errors"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"syscall"
	"time"

	"golang.org/x/sys/windows"
)

// newProviderExecCommand launches a resolved provider executable or npm
// launcher on Windows. npm and npm-installed provider commands are .cmd (or
// .ps1) shims that CreateProcess cannot run directly, so the argv pieces are
// routed through the owning interpreter; Go performs Windows command-line
// quoting exactly once. Shell command strings are never assembled here.
func newProviderExecCommand(ctx context.Context, executable string, args ...string) *exec.Cmd {
	var command *exec.Cmd
	switch strings.ToLower(filepath.Ext(executable)) {
	case ".cmd", ".bat":
		command = exec.CommandContext(ctx, installCommandInterpreter(), append([]string{"/D", "/S", "/C", "call", executable}, args...)...)
	case ".ps1":
		command = exec.CommandContext(ctx, "powershell.exe", append([]string{
			"-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", executable,
		}, args...)...)
	default:
		command = exec.CommandContext(ctx, executable, args...)
	}
	// npm launchers wrap a node process: killing only the wrapper on timeout
	// leaves the real child holding the partial global install. Cancel the
	// complete process tree instead.
	command.SysProcAttr = &syscall.SysProcAttr{CreationFlags: windows.CREATE_NEW_PROCESS_GROUP}
	command.WaitDelay = 500 * time.Millisecond
	command.Cancel = func() error {
		if command.Process == nil {
			return nil
		}
		if err := exec.Command("taskkill.exe", "/PID", strconv.Itoa(command.Process.Pid), "/T", "/F").Run(); err == nil {
			return nil
		}
		if killErr := command.Process.Kill(); killErr != nil {
			return errors.Join(err, killErr)
		}
		return nil
	}
	return command
}

func installCommandInterpreter() string {
	if value := strings.TrimSpace(os.Getenv("ComSpec")); value != "" {
		return value
	}
	return "cmd.exe"
}
