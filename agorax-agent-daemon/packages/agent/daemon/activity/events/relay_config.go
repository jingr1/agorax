package events

import hostservicespkg "agorax.local/agent-daemon/packages/agent/daemon/internal/hostservices"

const (
	ServiceGroup = "agent-activity"
)

// RelayConfig is the JSON configuration file written into the VM that
// tells the unified agent activity how to reach the host-side ingress
// service via a reverse link.
type RelayConfig struct {
	SchemaVersion  string                       `json:"schema_version"`
	RoomID         string                       `json:"room_id,omitempty"`
	WorkspaceID    string                       `json:"workspace_id"`
	WorkspaceRoot  string                       `json:"workspace_root,omitempty"`
	ServiceGroup   string                       `json:"service_group,omitempty"`
	Endpoint       hostservicespkg.HostEndpoint `json:"endpoint"`
	CursorPath     string                       `json:"cursor_path,omitempty"`
	FlushTimeoutMs int                          `json:"flush_timeout_ms"`
}
