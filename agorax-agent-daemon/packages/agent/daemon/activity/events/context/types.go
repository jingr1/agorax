package agentcontext

import "time"

type Identity struct {
	Known             bool              `json:"known"`
	Provider          string            `json:"provider,omitempty"`
	ProviderSessionID string            `json:"provider_session_id,omitempty"`
	CWD               string            `json:"cwd,omitempty"`
	Confidence        string            `json:"confidence,omitempty"`
	Source            string            `json:"source,omitempty"`
	Metadata          map[string]string `json:"metadata,omitempty"`
}

type Agent struct {
	AgentID           string `json:"agent_id,omitempty"`
	UserID            string `json:"user_id,omitempty"`
	Provider          string `json:"provider"`
	AgentType         string `json:"agent_type,omitempty"`
	Model             string `json:"model,omitempty"`
	ProviderSessionID string `json:"provider_session_id,omitempty"`
	IsSelf            *bool  `json:"is_self,omitempty"`
	EffectiveStatus   string `json:"effective_status,omitempty"`
	WorkPhase         string `json:"work_phase,omitempty"`
	Title             string `json:"title,omitempty"`
	CWD               string `json:"cwd,omitempty"`
	UpdatedAt         string `json:"updated_at,omitempty"`
}

type Warning struct {
	Code    string `json:"code"`
	Message string `json:"message"`
}

type Query struct {
	Kind   string `json:"kind"`
	RoomID string `json:"room_id"`
	CWD    string `json:"cwd,omitempty"`
}

type Summary struct {
	ActiveAgentCount      int   `json:"active_agent_count"`
	OtherActiveAgentCount *int  `json:"other_active_agent_count"`
	HasOtherWorkingAgents *bool `json:"has_other_working_agents"`
	SelfExcluded          bool  `json:"self_excluded"`
}

type ActivePeersResponse struct {
	SchemaVersion int       `json:"schema_version"`
	OK            bool      `json:"ok"`
	Query         Query     `json:"query"`
	GeneratedAt   string    `json:"generated_at"`
	Self          Identity  `json:"self"`
	Summary       Summary   `json:"summary"`
	Agents        []Agent   `json:"agents"`
	Warnings      []Warning `json:"warnings"`
}

type ActivePeersInput struct {
	RoomID string
	CWD    string
	Self   Identity
	Agents []Agent
	Now    time.Time
}

func BuildActivePeersResponse(input ActivePeersInput) ActivePeersResponse {
	now := input.Now
	if now.IsZero() {
		now = time.Now().UTC()
	}

	agents := append([]Agent(nil), input.Agents...)
	summary := Summary{ActiveAgentCount: len(agents)}
	var warnings []Warning

	if input.Self.Known && input.Self.Provider != "" && input.Self.ProviderSessionID != "" {
		otherCount := 0
		for i := range agents {
			isSelf := sameProviderSession(agents[i].Provider, agents[i].ProviderSessionID, input.Self)
			if isSelf && agents[i].Provider == "" {
				agents[i].Provider = input.Self.Provider
			}
			agents[i].IsSelf = boolPtr(isSelf)
			if !isSelf {
				otherCount++
			}
		}
		summary.OtherActiveAgentCount = intPtr(otherCount)
		summary.HasOtherWorkingAgents = boolPtr(otherCount > 0)
		summary.SelfExcluded = true
	} else {
		for i := range agents {
			agents[i].IsSelf = nil
		}
		warnings = append(warnings, Warning{
			Code:    "SELF_IDENTITY_UNAVAILABLE",
			Message: "current provider session identity is unavailable; self filtering was not applied",
		})
	}

	return ActivePeersResponse{
		SchemaVersion: 1,
		OK:            true,
		Query:         Query{Kind: "active_peers", RoomID: input.RoomID, CWD: input.CWD},
		GeneratedAt:   now.Format(time.RFC3339Nano),
		Self:          input.Self,
		Summary:       summary,
		Agents:        agents,
		Warnings:      warnings,
	}
}

func sameProviderSession(provider string, providerSessionID string, self Identity) bool {
	if providerSessionID == "" || providerSessionID != self.ProviderSessionID {
		return false
	}
	if provider == "" {
		return true
	}
	return provider == self.Provider
}

func boolPtr(value bool) *bool {
	return &value
}

func intPtr(value int) *int {
	return &value
}
