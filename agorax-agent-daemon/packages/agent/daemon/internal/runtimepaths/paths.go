package runtimepaths

import (
	"os"
	"path/filepath"
	"strings"
)

const BundlePreloadSOPath = ""

type Paths struct {
	root string
}

func Default() Paths {
	return Paths{root: filepath.Join(defaultStateDir(), "agent")}
}

func (p Paths) AgentPath(parts ...string) string {
	all := append([]string{p.root}, parts...)
	return filepath.Join(all...)
}

func defaultStateDir() string {
	if override := strings.TrimSpace(os.Getenv("AGORAX_STATE_DIR")); override != "" {
		return override
	}

	homeDir, err := os.UserHomeDir()
	if err != nil || strings.TrimSpace(homeDir) == "" {
		if IsDevelopmentEnv() {
			return ".agorax-dev"
		}
		return ".agorax"
	}

	dirName := ".agorax"
	if IsDevelopmentEnv() {
		dirName = ".agorax-dev"
	}
	return filepath.Join(homeDir, dirName)
}

// IsDevelopmentEnv reports whether this process runs against the development
// state root, which also selects the development Agorax CLI binary name.
func IsDevelopmentEnv() bool {
	switch strings.ToLower(strings.TrimSpace(os.Getenv("AGORAX_ENV"))) {
	case "dev", "development", "local":
		return true
	default:
		return false
	}
}
