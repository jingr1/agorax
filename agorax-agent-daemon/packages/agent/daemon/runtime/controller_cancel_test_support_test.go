package agentruntime

func rootCancelInput(roomID string, agentSessionID string, turnID string, reason string) CancelInput {
	return CancelInput{
		RoomID:             roomID,
		RootAgentSessionID: agentSessionID,
		Targets: []CancelTarget{{
			AgentSessionID: agentSessionID,
			TurnID:         turnID,
		}},
		Reason: reason,
	}
}
