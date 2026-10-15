package agentcontext

import (
	"encoding/json"
	"fmt"
	"os"
	"strings"

	hostservicespkg "agorax.local/agent-daemon/packages/agent/daemon/internal/hostservices"
	runtimepaths "agorax.local/agent-daemon/packages/agent/daemon/internal/runtimepaths"
)

const ServiceGroup = "agent-context"

var DefaultAgentContextConfigPath = runtimepaths.Default().AgentPath("codex", "agorax", "current", "agent-context.json")

type ConfigInput struct {
	RoomID     string
	CWD        string
	ConfigPath string
}

type Config struct {
	SchemaVersion int                          `json:"schema_version"`
	RoomID        string                       `json:"room_id"`
	WorkspaceID   string                       `json:"workspace_id"`
	ServiceGroup  string                       `json:"service_group"`
	Endpoint      hostservicespkg.HostEndpoint `json:"endpoint"`

	CWD        string `json:"-"`
	ConfigPath string `json:"-"`
}

func ResolveConfig(input ConfigInput) (Config, error) {
	roomID := firstNonEmpty(strings.TrimSpace(input.RoomID), strings.TrimSpace(os.Getenv("AGORAX_WORKSPACE_ID")))
	cwd := strings.TrimSpace(input.CWD)
	configPath := firstNonEmpty(
		strings.TrimSpace(input.ConfigPath),
		strings.TrimSpace(os.Getenv("AGORAX_AGENT_CONTEXT_CONFIG")),
	)

	var cfg Config
	if configPath != "" {
		loaded, err := ReadConfig(configPath)
		if err == nil {
			cfg = loaded
		}
	}
	if cfg.RoomID == "" && configPath == "" {
		if loaded, err := ReadConfig(DefaultAgentContextConfigPath); err == nil {
			cfg = loaded
			configPath = DefaultAgentContextConfigPath
		}
	}
	if roomID != "" {
		cfg.RoomID = roomID
	}
	cfg.CWD = cwd
	cfg.ConfigPath = configPath
	if strings.TrimSpace(cfg.ServiceGroup) == "" {
		cfg.ServiceGroup = ServiceGroup
	}
	return cfg, nil
}

func ReadConfig(path string) (Config, error) {
	raw, err := os.ReadFile(path)
	if err != nil {
		return Config{}, fmt.Errorf("read agent context config: %w", err)
	}
	var cfg Config
	if err := json.Unmarshal(raw, &cfg); err != nil {
		return Config{}, fmt.Errorf("parse agent context config: %w", err)
	}
	cfg.ConfigPath = path
	return cfg, nil
}

func firstNonEmpty(values ...string) string {
	for _, value := range values {
		if strings.TrimSpace(value) != "" {
			return value
		}
	}
	return ""
}
