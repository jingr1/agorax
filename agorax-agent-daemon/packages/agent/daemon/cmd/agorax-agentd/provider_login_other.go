//go:build !windows

package main

import (
	"fmt"
	"os/exec"
	"strings"
	"syscall"
)

func detachProviderProcess(cmd *exec.Cmd) {
	if cmd.SysProcAttr == nil {
		cmd.SysProcAttr = &syscall.SysProcAttr{}
	}
	cmd.SysProcAttr.Setsid = true
}

// buildLoginTerminalCommand wraps the provider login argv in a common terminal
// emulator so interactive TTY login works on graphical Linux/macOS hosts.
func buildLoginTerminalCommand(binary string, loginArgs []string, environ []string) ([]string, bool) {
	script := shellJoin(append([]string{binary}, loginArgs...)) + `; echo; echo "登录结束后按 Enter 关闭…"; read`
	if override := strings.TrimSpace(envValueLast(environ, "AGORAX_LOGIN_TERMINAL")); override != "" {
		return []string{override, "-e", "bash", "-lc", script}, true
	}
	candidates := []struct {
		bin  string
		args []string
	}{
		{"gnome-terminal", []string{"--", "bash", "-lc", script}},
		{"konsole", []string{"-e", "bash", "-lc", script}},
		{"xfce4-terminal", []string{"-e", "bash -lc " + shellQuote(script)}},
		{"x-terminal-emulator", []string{"-e", "bash", "-lc", script}},
		{"xterm", []string{"-e", "bash", "-lc", script}},
	}
	for _, candidate := range candidates {
		if path, err := exec.LookPath(candidate.bin); err == nil {
			return append([]string{path}, candidate.args...), true
		}
	}
	// macOS Terminal.app via osascript preserves full argv.
	if _, err := exec.LookPath("osascript"); err == nil {
		osa := fmt.Sprintf(
			`tell application "Terminal" to do script %s`,
			shellQuote(shellJoin(append([]string{binary}, loginArgs...))),
		)
		return []string{"osascript", "-e", osa}, true
	}
	return nil, false
}

func shellJoin(parts []string) string {
	quoted := make([]string, len(parts))
	for i, part := range parts {
		quoted[i] = shellQuote(part)
	}
	return strings.Join(quoted, " ")
}

func shellQuote(value string) string {
	if value == "" {
		return "''"
	}
	return "'" + strings.ReplaceAll(value, "'", `'"'"'`) + "'"
}
