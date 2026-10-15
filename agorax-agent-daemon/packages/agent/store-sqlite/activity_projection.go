package storesqlite

import (
	agentactivityprojection "agorax.local/agent-daemon/packages/agent/store-sqlite/canonical"
)

func sessionStateReportApplied(input SessionStateReport, session agentactivityprojection.SessionSnapshot) bool {
	if input.OccurredAtUnixMS > 0 &&
		session.LastEventUnixMS > 0 &&
		input.OccurredAtUnixMS < session.LastEventUnixMS {
		return false
	}
	return true
}

func projectionSessionToDTO(session agentactivityprojection.SessionSnapshot) (Session, error) {
	metadata, legacyCapabilities, internal, err := splitSessionRuntimeContext(session.RuntimeContext)
	if err != nil {
		return Session{}, err
	}
	capabilities := session.Capabilities
	if capabilities == nil {
		capabilities = legacyCapabilities
	}
	return Session{
		ID:                     session.AgentSessionID,
		WorkspaceID:            session.WorkspaceID,
		Kind:                   session.Kind,
		RootAgentSessionID:     session.RootAgentSessionID,
		RootTurnID:             session.RootTurnID,
		ParentAgentSessionID:   session.ParentAgentSessionID,
		ParentTurnID:           session.ParentTurnID,
		ParentToolCallID:       session.ParentToolCallID,
		Origin:                 session.Origin,
		UserID:                 session.UserID,
		AgentTargetID:          session.AgentTargetID,
		Provider:               session.Provider,
		ProviderSessionID:      session.ProviderSessionID,
		Model:                  session.Model,
		Settings:               cloneJSONMap(session.Settings),
		Capabilities:           agentactivityprojection.CloneCapabilitySnapshot(capabilities),
		Metadata:               metadata,
		InternalRuntimeContext: internal,
		Cwd:                    session.CWD,
		Title:                  session.Title,
		MessageVersion:         session.MessageVersion,
		LastEventUnixMS:        session.LastEventUnixMS,
		StartedAtUnixMS:        session.StartedAtUnixMS,
		EndedAtUnixMS:          session.EndedAtUnixMS,
		CreatedAtUnixMS:        session.CreatedAtUnixMS,
		UpdatedAtUnixMS:        session.UpdatedAtUnixMS,
	}, nil
}
