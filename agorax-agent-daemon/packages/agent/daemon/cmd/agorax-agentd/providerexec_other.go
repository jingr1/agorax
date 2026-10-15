//go:build !windows

package main

import (
	"context"
	"os/exec"
)

// newProviderExecCommand launches a resolved provider executable or npm
// launcher directly. POSIX executables (including npm's extensionless node
// wrappers) are CreateProcess/Posix_spawn entry points, so the resolved path
// runs as-is with an argv array — never a shell string.
func newProviderExecCommand(ctx context.Context, executable string, args ...string) *exec.Cmd {
	return exec.CommandContext(ctx, executable, args...)
}
