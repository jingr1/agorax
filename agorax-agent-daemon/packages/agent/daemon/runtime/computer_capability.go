package agentruntime

// computerUseEnabledEnv is the per-session marker the sidecar sets when
// computer use is enabled for a session. The adapters surface the
// `computerUse` capability based on it so the composer toggle reflects the
// live session. Computer use is delivered out-of-band via the `agorax computer`
// CLI (a daemon-owned cua-driver MCP), not through provider MCP injection.
const computerUseEnabledEnv = "AGORAX_COMPUTER_USE_ENABLED"

func appendComputerUseCapability(capabilities []string, env []string) []string {
	if sessionEnvBool(env, computerUseEnabledEnv) {
		return append(capabilities, CapabilityComputerUse)
	}
	return capabilities
}
