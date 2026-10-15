package agentruntime

func standardTestSession(provider string) Session {
	return Session{
		RoomID:            "room-1",
		AgentSessionID:    "agent-session-1",
		Provider:          provider,
		ProviderSessionID: "agent-session-1",
		CWD:               "/workspace/room-1",
		Status:            SessionStatusReady,
		Title:             provider,
	}
}
