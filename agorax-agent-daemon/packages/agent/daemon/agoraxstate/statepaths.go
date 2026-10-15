package agoraxstate

import (
	"errors"
	"os"
	"path/filepath"
	"strings"
)

func DaemonDBPath() string {
	return ResolveDefaultsFromEnv().State.DaemonDBPath
}

func DaemonLogsDir() string {
	return ResolveDefaultsFromEnv().State.LogsDir
}

func DaemonLogPath() string {
	return ResolveDefaultsFromEnv().State.DaemonLogPath
}

func DaemonRunDir() string {
	return ResolveDefaultsFromEnv().State.RunDir
}

func DaemonListenerInfoPath() string {
	return ResolveDefaultsFromEnv().State.DaemonListenerInfoPath
}

func DaemonPIDPath() string {
	return ResolveDefaultsFromEnv().State.DaemonPIDPath
}

func DaemonStateOwnershipLockPath() string {
	return filepath.Join(
		DefaultStateDir(),
		generatedDefaults.State.RunDirName,
		generatedDefaults.State.PIDFileName+".lock",
	)
}

func DefaultStateDir() string {
	return ResolveDefaultsFromEnv().State.RootDir
}

func DefaultAgentRuntimeDir() (string, error) {
	if override := strings.TrimSpace(os.Getenv("AGORAX_AGENT_RUNTIME_DIR")); override != "" {
		return override, nil
	}
	homeDir, err := userHomeDir()
	if err != nil {
		return "", err
	}
	return filepath.Join(homeDir, ".local", "share", "agorax", "agent-runtimes"), nil
}

func DefaultAgentExecutableDir() (string, error) {
	homeDir, err := userHomeDir()
	if err != nil {
		return "", err
	}
	return filepath.Join(homeDir, ".local", "bin"), nil
}

func userHomeDir() (string, error) {
	homeDir, err := os.UserHomeDir()
	if err != nil {
		return "", err
	}
	homeDir = strings.TrimSpace(homeDir)
	if homeDir == "" {
		return "", errors.New("user home directory is unavailable")
	}
	return homeDir, nil
}

func IsDevelopmentEnv() bool {
	return ResolveDefaultsFromEnv().Runtime.Env == "development"
}

func DesktopLoginCallbackURL() string {
	if IsDevelopmentEnv() {
		return "agorax-dev://login/callback"
	}
	return "agorax://login/callback"
}
