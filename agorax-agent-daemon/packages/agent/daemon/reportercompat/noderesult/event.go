package noderesult

import (
	"context"

	reporterservice "agorax.local/agent-daemon/packages/agent/daemon/reportercompat"
)

type Params map[string]any

func Track(ctx context.Context, reporter reporterservice.Reporter, params Params) {
	if reporter == nil {
		return
	}
	reporter.Track("agent.node_result", map[string]any(params))
}
