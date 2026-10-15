package agentruntime

import (
	"encoding/json"
	"io"
	"os"
	"path/filepath"
	"strconv"
	"strings"
)

// This file ports the TypeScript CLI adapter's spawn-env contract
// (claude-code-adapter.ts buildClaudeSpawnEnv): `claude -p` does not reliably
// apply the ~/.claude/settings.json `env` block for authentication the way an
// interactive session does, so the adapter injects it explicitly, and mirrors
// ANTHROPIC_AUTH_TOKEN onto ANTHROPIC_API_KEY because print mode otherwise
// falls through to a broken keychain path (401 against proxied endpoints).
// Values are injected through the process environment only — never argv or
// logs.

const maxClaudeSettingsBytes = 1 << 20

// claudeCodeSettingsPath resolves the user settings file the same way the TS
// adapter does: the .claude directory under the user's home directory.
func claudeCodeSettingsPath() string {
	home, err := os.UserHomeDir()
	if err != nil || strings.TrimSpace(home) == "" {
		return ""
	}
	return filepath.Join(home, ".claude", "settings.json")
}

// claudeCodeSettingsEnv returns the settings.json `env` block as KEY=VALUE
// entries. Missing or malformed settings yield nil: the provider falls back
// to its ordinary auth discovery.
func claudeCodeSettingsEnv() []string {
	path := claudeCodeSettingsPath()
	if path == "" {
		return nil
	}
	file, err := os.Open(filepath.Clean(path))
	if err != nil {
		return nil
	}
	defer func() { _ = file.Close() }()
	var settings struct {
		Env map[string]any `json:"env"`
	}
	decoder := json.NewDecoder(io.LimitReader(file, maxClaudeSettingsBytes))
	if decoder.Decode(&settings) != nil || len(settings.Env) == 0 {
		return nil
	}
	env := make([]string, 0, len(settings.Env))
	for key, value := range settings.Env {
		key = strings.TrimSpace(key)
		if key == "" || value == nil {
			continue
		}
		switch typed := value.(type) {
		case string:
			env = append(env, key+"="+typed)
		case bool:
			env = append(env, key+"="+strconv.FormatBool(typed))
		case float64:
			env = append(env, key+"="+strconv.FormatFloat(typed, 'f', -1, 64))
		default:
			continue
		}
	}
	return env
}

// claudeAuthMirrorEnv mirrors ANTHROPIC_AUTH_TOKEN onto ANTHROPIC_API_KEY
// when no API key is present anywhere in the effective environment (daemon
// process env plus launch overrides). Print mode otherwise falls through to a
// broken keychain path and proxied endpoints answer 401.
func claudeAuthMirrorEnv(env []string) []string {
	merged := append(os.Environ(), env...)
	authToken := strings.TrimSpace(envValueFromList(merged, "ANTHROPIC_AUTH_TOKEN"))
	if authToken == "" {
		return nil
	}
	if apiKey := strings.TrimSpace(envValueFromList(merged, "ANTHROPIC_API_KEY")); apiKey != "" {
		return nil
	}
	return []string{"ANTHROPIC_API_KEY=" + authToken}
}
