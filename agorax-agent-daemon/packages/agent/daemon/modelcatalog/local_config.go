package modelcatalog

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strings"
)

// LoadLocalProviderModels reads the same local config sources the Workspace
// legacy /models routes use (Claude settings.json, Codex config.toml), plus
// OpenCode's own model list (`opencode api GET /api/model` / `opencode models`).
// Returns nil when the provider is unknown or the config is missing — callers
// must not invent a fake catalog.
func LoadLocalProviderModels(provider string) []ModelOption {
	switch normalizeProviderKey(provider) {
	case "claude-code", "claude":
		return loadClaudeCodeModelsFromSettings()
	case "codex":
		return loadCodexModelsFromConfig()
	case "opencode":
		return loadOpenCodeModelsFromCLI()
	default:
		return nil
	}
}

func normalizeProviderKey(provider string) string {
	provider = strings.ToLower(strings.TrimSpace(provider))
	provider = strings.TrimPrefix(provider, "local:")
	return provider
}

func loadClaudeCodeModelsFromSettings() []ModelOption {
	settings := readClaudeSettingsJSON()
	if settings == nil {
		return nil
	}
	env := stringMapFromAny(settings["env"])
	seen := map[string]struct{}{}
	models := make([]ModelOption, 0, 8)
	push := func(id, display string, isDefault bool) {
		id = strings.TrimSpace(id)
		if id == "" {
			return
		}
		if _, ok := seen[id]; ok {
			if isDefault {
				for i := range models {
					if models[i].ID == id {
						models[i].IsDefault = true
					}
				}
			}
			return
		}
		seen[id] = struct{}{}
		display = firstNonBlank(strings.TrimSpace(display), id)
		models = append(models, ModelOption{
			ID:                         id,
			DisplayName:                display,
			IsDefault:                  isDefault,
			ReasoningEffortsAdvertised: true,
			SupportedReasoningEfforts:  claudeCodeReasoningEfforts(),
			DefaultReasoningEffort:     "medium",
		})
	}

	aliases := []struct {
		alias  string
		envKey string
	}{
		{"haiku", "ANTHROPIC_DEFAULT_HAIKU_MODEL"},
		{"sonnet", "ANTHROPIC_DEFAULT_SONNET_MODEL"},
		{"opus", "ANTHROPIC_DEFAULT_OPUS_MODEL"},
		{"fable", "ANTHROPIC_DEFAULT_FABLE_MODEL"},
	}
	for _, entry := range aliases {
		push(env[entry.envKey], entry.alias, false)
	}

	rawModel := strings.TrimSpace(stringMapValue(settings, "model"))
	current := expandClaudeAlias(rawModel, env)
	push(current, rawModel, true)
	return models
}

func claudeCodeReasoningEfforts() []ReasoningEffortOption {
	return []ReasoningEffortOption{
		{Value: "low", Label: "Low"},
		{Value: "medium", Label: "Medium", Default: true},
		{Value: "high", Label: "High"},
		{Value: "xhigh", Label: "Extra high"},
		{Value: "max", Label: "Max"},
	}
}

func expandClaudeAlias(alias string, env map[string]string) string {
	alias = strings.TrimSpace(alias)
	if alias == "" {
		return ""
	}
	switch strings.ToLower(alias) {
	case "haiku":
		return firstNonBlank(env["ANTHROPIC_DEFAULT_HAIKU_MODEL"], alias)
	case "sonnet":
		return firstNonBlank(env["ANTHROPIC_DEFAULT_SONNET_MODEL"], alias)
	case "opus":
		return firstNonBlank(env["ANTHROPIC_DEFAULT_OPUS_MODEL"], alias)
	case "fable":
		return firstNonBlank(env["ANTHROPIC_DEFAULT_FABLE_MODEL"], alias)
	default:
		return alias
	}
}

func readClaudeSettingsJSON() map[string]any {
	dir := strings.TrimSpace(os.Getenv("CLAUDE_CONFIG_DIR"))
	if dir == "" {
		home, err := os.UserHomeDir()
		if err != nil {
			return nil
		}
		dir = filepath.Join(home, ".claude")
	}
	data, err := os.ReadFile(filepath.Join(dir, "settings.json"))
	if err != nil {
		return nil
	}
	var parsed map[string]any
	if err := json.Unmarshal(data, &parsed); err != nil {
		return nil
	}
	return parsed
}

func loadCodexModelsFromConfig() []ModelOption {
	cfg := readCodexConfigTOML()
	if cfg == nil {
		return nil
	}
	current := strings.TrimSpace(cfg.model)
	providerID := strings.TrimSpace(cfg.provider)
	seen := map[string]struct{}{}
	models := make([]ModelOption, 0, 8)
	push := func(id string, isDefault bool) {
		id = strings.TrimSpace(id)
		if id == "" {
			return
		}
		if _, ok := seen[id]; ok {
			if isDefault {
				for i := range models {
					if models[i].ID == id {
						models[i].IsDefault = true
					}
				}
			}
			return
		}
		seen[id] = struct{}{}
		models = append(models, ModelOption{
			ID:          id,
			DisplayName: id,
			IsDefault:   isDefault,
		})
	}
	if current != "" {
		push(current, true)
	}
	if providerID != "" {
		for _, id := range cfg.providerModels[providerID] {
			push(id, false)
		}
	}
	return models
}

type codexConfigSnapshot struct {
	model          string
	provider       string
	providerModels map[string][]string
}

// Minimal TOML reader for Codex config: top-level keys + one-level nested
// tables (same shape the Workspace TypeScript reader understands).
func readCodexConfigTOML() *codexConfigSnapshot {
	home := strings.TrimSpace(os.Getenv("CODEX_HOME"))
	if home == "" {
		userHome, err := os.UserHomeDir()
		if err != nil {
			return nil
		}
		home = filepath.Join(userHome, ".codex")
	}
	data, err := os.ReadFile(filepath.Join(home, "config.toml"))
	if err != nil {
		return nil
	}
	result := map[string]any{}
	section := []string{}
	for _, raw := range strings.Split(string(data), "\n") {
		line := strings.TrimSpace(stripTOMLComment(raw))
		if line == "" {
			continue
		}
		if strings.HasPrefix(line, "[") {
			end := strings.Index(line, "]")
			if end < 0 {
				continue
			}
			inner := strings.TrimSpace(line[1:end])
			section = strings.Split(inner, ".")
			for i := range section {
				section[i] = strings.TrimSpace(section[i])
			}
			if len(section) == 1 && section[0] != "" {
				if _, ok := result[section[0]]; !ok {
					result[section[0]] = map[string]any{}
				}
			}
			continue
		}
		before, after, ok := strings.Cut(line, "=")
		if !ok {
			continue
		}
		key := strings.TrimSpace(before)
		value := unquoteTOML(strings.TrimSpace(after))
		switch len(section) {
		case 0:
			result[key] = value
		case 2:
			parent := section[0]
			child := section[1]
			parentObj, _ := result[parent].(map[string]any)
			if parentObj == nil {
				parentObj = map[string]any{}
			}
			childObj, _ := parentObj[child].(map[string]any)
			if childObj == nil {
				childObj = map[string]any{}
			}
			childObj[key] = value
			parentObj[child] = childObj
			result[parent] = parentObj
		}
	}

	snap := &codexConfigSnapshot{
		providerModels: map[string][]string{},
	}
	if model, ok := result["model"].(string); ok {
		snap.model = model
	}
	if provider, ok := result["model_provider"].(string); ok {
		snap.provider = provider
	} else if provider, ok := result["provider"].(string); ok {
		snap.provider = provider
	}
	if providers, ok := result["model_providers"].(map[string]any); ok {
		for id, raw := range providers {
			block, ok := raw.(map[string]any)
			if !ok {
				continue
			}
			rawModels := block["models"]
			switch typed := rawModels.(type) {
			case []any:
				for _, item := range typed {
					if text, ok := item.(string); ok && strings.TrimSpace(text) != "" {
						snap.providerModels[id] = append(snap.providerModels[id], strings.TrimSpace(text))
					}
				}
			case string:
				// Single-line array like ["a", "b"] — parse lightly.
				for _, part := range splitTOMLStringArray(typed) {
					snap.providerModels[id] = append(snap.providerModels[id], part)
				}
			}
		}
	}
	return snap
}

func stripTOMLComment(line string) string {
	inQuote := false
	quote := byte(0)
	for i := 0; i < len(line); i++ {
		ch := line[i]
		if inQuote {
			if ch == quote && (i == 0 || line[i-1] != '\\') {
				inQuote = false
			}
			continue
		}
		if ch == '"' || ch == '\'' {
			inQuote = true
			quote = ch
			continue
		}
		if ch == '#' {
			return line[:i]
		}
	}
	return line
}

func unquoteTOML(value string) string {
	if len(value) >= 2 {
		if (value[0] == '"' && value[len(value)-1] == '"') ||
			(value[0] == '\'' && value[len(value)-1] == '\'') {
			return value[1 : len(value)-1]
		}
	}
	// Inline arrays are left as raw strings for splitTOMLStringArray.
	return value
}

func splitTOMLStringArray(raw string) []string {
	raw = strings.TrimSpace(raw)
	if !strings.HasPrefix(raw, "[") || !strings.HasSuffix(raw, "]") {
		return nil
	}
	inner := strings.TrimSpace(raw[1 : len(raw)-1])
	if inner == "" {
		return nil
	}
	parts := strings.Split(inner, ",")
	out := make([]string, 0, len(parts))
	for _, part := range parts {
		part = unquoteTOML(strings.TrimSpace(part))
		if part != "" {
			out = append(out, part)
		}
	}
	return out
}

func stringMapFromAny(value any) map[string]string {
	raw, ok := value.(map[string]any)
	if !ok || raw == nil {
		return map[string]string{}
	}
	out := make(map[string]string, len(raw))
	for key, item := range raw {
		switch typed := item.(type) {
		case string:
			out[key] = typed
		case float64, bool, json.Number:
			out[key] = fmt.Sprint(typed)
		}
	}
	return out
}
