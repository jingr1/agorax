package agentsessionstore

import canonical "agorax.local/agent-daemon/packages/agent/store-sqlite/canonical"

// WorkspaceAgentCapabilityReference is immutable submission provenance. It is
// deliberately not a source of truth for Agorax-owned activation state.
type WorkspaceAgentCapabilityReference = canonical.WorkspaceAgentCapabilityReference
