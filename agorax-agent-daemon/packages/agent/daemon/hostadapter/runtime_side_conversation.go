package hostadapter

import (
	"context"

	agentruntime "agorax.local/agent-daemon/packages/agent/daemon/runtime"
	host "agorax.local/agent-daemon/packages/agent/host"
)

type sideConversationRuntimeBackend interface {
	SideCapabilitiesForSource(context.Context, agentruntime.Session) (agentruntime.SideConversationCapabilities, error)
	OpenSide(context.Context, agentruntime.SideConversationOpenInput) (agentruntime.SideConversationOpenResult, error)
}

func (a *RuntimeController) ResolveSideConversation(
	ctx context.Context,
	source host.ProviderRuntimeSession,
) (host.SideConversationCapabilities, error) {
	if err := a.requireBackend(); err != nil {
		return host.SideConversationCapabilities{}, err
	}
	backend, ok := a.Backend.(sideConversationRuntimeBackend)
	if !ok {
		return host.SideConversationCapabilities{}, nil
	}
	capabilities, err := backend.SideCapabilitiesForSource(ctx, runtimeSession(source))
	return hostSideCapabilities(capabilities), mapRuntimeError(err)
}

func (a *RuntimeController) OpenSideConversation(
	ctx context.Context,
	input host.RuntimeOpenSideConversationInput,
) (host.OpenSideConversationResult, error) {
	if err := a.requireBackend(); err != nil {
		return host.OpenSideConversationResult{}, err
	}
	backend, ok := a.Backend.(sideConversationRuntimeBackend)
	if !ok {
		return host.OpenSideConversationResult{}, host.ErrSideConversationUnsupported
	}
	result, err := backend.OpenSide(
		ctx,
		agentruntime.SideConversationOpenInput{
			RoomID:               input.Source.WorkspaceID,
			SourceAgentSessionID: input.Source.ID,
			SideAgentSessionID:   input.SideAgentSessionID,
			RequestID:            input.RequestID,
			Source:               runtimeSession(input.Source),
		},
	)
	if err != nil {
		return host.OpenSideConversationResult{}, mapRuntimeError(err)
	}
	return host.OpenSideConversationResult{
		Session:      a.sessionWithState(result.Session),
		Capabilities: hostSideCapabilities(result.Capabilities),
	}, nil
}

func hostSideCapabilities(
	capabilities agentruntime.SideConversationCapabilities,
) host.SideConversationCapabilities {
	return host.SideConversationCapabilities{
		Supported:             capabilities.Supported,
		ActiveSourceTurn:      capabilities.ActiveSourceTurn,
		Ephemeral:             capabilities.Ephemeral,
		HideInheritedTurns:    capabilities.HideInheritedTurns,
		ModelBoundaryInjected: capabilities.ModelBoundaryInjected,
	}
}
