package agentstatus

import (
	"context"
	"errors"
	"time"
)

// Local Claude SDK account-usage probe types. Agorax's runtime exports these;
// Agorax's forked runtime does not yet, so agentstatus owns a compatible
// seam and defaults production probing to unsupported.
type ClaudeSDKAccountUsageProbeInput struct {
	Provider string
	Command  []string
	Env      []string
	CWD      string
	Timeout  time.Duration
}

type ClaudeSDKAccountUsageProbeResult struct {
	Usage map[string]any
	Error error
}

var errClaudeSDKAccountUsageUnsupported = errors.New("claude sdk account usage probe is not available in agorax runtime")

func probeClaudeSDKAccountUsageUnsupported(
	_ context.Context,
	_ ClaudeSDKAccountUsageProbeInput,
) ClaudeSDKAccountUsageProbeResult {
	return ClaudeSDKAccountUsageProbeResult{Error: errClaudeSDKAccountUsageUnsupported}
}
