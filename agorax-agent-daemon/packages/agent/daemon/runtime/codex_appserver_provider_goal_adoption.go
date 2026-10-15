package agentruntime

import (
	"context"
	"log/slog"
	"strings"
)

type providerGoalGenerationRoute uint8

const (
	providerGoalGenerationKnownCurrent providerGoalGenerationRoute = iota
	providerGoalGenerationPendingLocal
	providerGoalGenerationStale
	providerGoalGenerationBindCurrent
	providerGoalGenerationAdopt
)

// scheduleProviderGoalAdoption moves provider-native create_goal persistence
// off the app-server read loop. The in-flight generation marker keeps any
// immediately following continuation buffered until Host accepts or rejects
// the generation.
func (a *CodexAppServerAdapter) scheduleProviderGoalAdoption(session Session, goal map[string]any) {
	fingerprint := codexGoalGenerationFingerprint(goal)
	if a == nil || fingerprint == "" ||
		strings.TrimSpace(asString(goal["status"])) != "active" {
		return
	}
	agentSessionID := strings.TrimSpace(session.AgentSessionID)
	a.mu.Lock()
	appSession := a.sessions[agentSessionID]
	if appSession == nil || appSession.provenanceDegraded {
		a.mu.Unlock()
		return
	}
	current := goalOperationIdentity{
		operationID: appSession.goalOperationID,
		revision:    appSession.goalRevision,
		repairEpoch: appSession.goalRepairEpoch,
	}
	route := classifyProviderGoalGenerationLocked(appSession, goal, fingerprint, current)
	if route == providerGoalGenerationKnownCurrent ||
		route == providerGoalGenerationPendingLocal ||
		route == providerGoalGenerationStale {
		a.mu.Unlock()
		return
	}
	sink := a.providerGoalAdoptionSink
	threadID := appSession.threadID
	if sink == nil || strings.TrimSpace(asString(goal["threadId"])) != threadID {
		a.mu.Unlock()
		return
	}
	if appSession.providerGoalAdoptionsInFlight == nil {
		appSession.providerGoalAdoptionsInFlight = make(map[string]struct{})
	}
	if _, inFlight := appSession.providerGoalAdoptionsInFlight[fingerprint]; inFlight {
		a.mu.Unlock()
		return
	}
	appSession.providerGoalAdoptionsInFlight[fingerprint] = struct{}{}
	a.mu.Unlock()
	session.ProviderSessionID = threadID
	if route == providerGoalGenerationBindCurrent {
		go a.bindCurrentProviderGoalGeneration(session, clonePayload(goal), fingerprint, current)
		return
	}
	go a.adoptProviderGoalGeneration(session, clonePayload(goal), fingerprint, current.revision, sink, threadID)
}

func classifyProviderGoalGenerationLocked(
	appSession *codexAppServerSession,
	goal map[string]any,
	fingerprint string,
	current goalOperationIdentity,
) providerGoalGenerationRoute {
	if appSession == nil {
		return providerGoalGenerationStale
	}
	if binding, found := appSession.goalGenerationBindings[fingerprint]; found {
		if binding.ambiguous {
			return providerGoalGenerationStale
		}
		if binding.identity == current {
			return providerGoalGenerationKnownCurrent
		}
		// Pause/resume advance the live operation identity without rebinding
		// the set-time generation. Provider progress (including terminal
		// complete) for that still-current generation must not be dropped as
		// stale, or a later continuation nudge will revive an already-finished
		// Goal. Cleared Goals leave appSession.goal empty and stay stale.
		if len(appSession.goal) > 0 &&
			fingerprint == appSession.currentGoalGenerationFingerprint &&
			appSession.currentGoalGenerationIdentity == binding.identity {
			return providerGoalGenerationKnownCurrent
		}
		return providerGoalGenerationStale
	}
	if claim := appSession.goalContinuationClaim; claim != nil && !claim.ready && claim.identity == current {
		return providerGoalGenerationPendingLocal
	}
	lineage := codexGoalGenerationLineage(goal)
	if lineage != "" && lineage == appSession.currentGoalGenerationLineage {
		if !current.valid() || appSession.currentGoalGenerationIdentity != current {
			return providerGoalGenerationStale
		}
		return providerGoalGenerationBindCurrent
	}
	return providerGoalGenerationAdopt
}

func (a *CodexAppServerAdapter) providerGoalUpdateSuperseded(agentSessionID string, goal map[string]any) bool {
	if a == nil {
		return true
	}
	fingerprint := codexGoalGenerationFingerprint(goal)
	if fingerprint == "" {
		return false
	}
	a.mu.Lock()
	defer a.mu.Unlock()
	appSession := a.sessions[strings.TrimSpace(agentSessionID)]
	if appSession == nil {
		return true
	}
	current := goalOperationIdentity{
		operationID: appSession.goalOperationID,
		revision:    appSession.goalRevision,
		repairEpoch: appSession.goalRepairEpoch,
	}
	if classifyProviderGoalGenerationLocked(appSession, goal, fingerprint, current) != providerGoalGenerationStale {
		return false
	}
	// Fingerprints include updatedAt, so pause/resume/complete snapshots miss
	// the set-time binding and fall through the lineage classifier. That path
	// also compares the live operation identity, which pause/resume advance
	// without rebinding. Keep applying provider progress for the session's
	// current generation lineage while a Goal is still present.
	lineage := codexGoalGenerationLineage(goal)
	if len(appSession.goal) > 0 &&
		lineage != "" &&
		lineage == appSession.currentGoalGenerationLineage &&
		appSession.currentGoalGenerationIdentity.valid() {
		return false
	}
	return true
}

func (a *CodexAppServerAdapter) bindCurrentProviderGoalGeneration(
	session Session,
	goal map[string]any,
	fingerprint string,
	identity goalOperationIdentity,
) {
	agentSessionID := strings.TrimSpace(session.AgentSessionID)
	defer a.finishProviderGoalAdoption(agentSessionID, fingerprint)
	if err := a.bindGoalGeneration(context.Background(), session, goal, identity); err != nil {
		slog.Warn("agent session app-server current Goal generation binding failed",
			"event", "agent_session.app_server.goal.current_generation_binding_failed",
			"agent_session_id", agentSessionID,
			"error", err.Error(),
		)
	}
}

// adoptProviderGoalGeneration gives a provider-native create_goal call a
// durable Host identity before any server-started continuation can inherit it.
// It does not weaken the existing fail-closed path: unavailable, conflicting,
// or malformed adoption leaves the continuation unproven.
func (a *CodexAppServerAdapter) adoptProviderGoalGeneration(
	session Session,
	goal map[string]any,
	fingerprint string,
	expectedRevision int64,
	sink ProviderGoalAdoptionSink,
	threadID string,
) {
	agentSessionID := strings.TrimSpace(session.AgentSessionID)
	defer a.finishProviderGoalAdoption(agentSessionID, fingerprint)
	ackCtx, cancel := context.WithTimeout(context.Background(), goalProvenanceDurableAckTimeout)
	binding, err := sink(ackCtx, session, ProviderGoalAdoptionRequest{
		Fingerprint:      fingerprint,
		ExpectedRevision: expectedRevision,
		Goal:             normalizedCodexGoal(goal),
	})
	cancel()
	if err != nil {
		slog.Warn("agent session app-server provider Goal adoption failed",
			"event", "agent_session.app_server.goal.provider_adoption_failed",
			"agent_session_id", agentSessionID,
			"error", err.Error(),
		)
		return
	}
	identity := goalOperationIdentity{
		operationID: strings.TrimSpace(binding.OperationID),
		revision:    binding.Revision,
		repairEpoch: binding.RepairEpoch,
	}
	if binding.Ambiguous || !identity.valid() {
		slog.Warn("agent session app-server provider Goal adoption returned invalid identity",
			"event", "agent_session.app_server.goal.provider_adoption_invalid",
			"agent_session_id", agentSessionID,
		)
		return
	}
	shouldArm, installed := a.installProviderGoalIdentity(agentSessionID, threadID, fingerprint, identity)
	if !installed {
		return
	}
	if err := a.bindGoalGeneration(context.Background(), session, goal, identity); err != nil {
		slog.Warn("agent session app-server provider Goal provenance binding failed",
			"event", "agent_session.app_server.goal.provider_adoption_binding_failed",
			"agent_session_id", agentSessionID,
			"error", err.Error(),
		)
		return
	}
	if shouldArm {
		a.armGoalContinuationClaim(agentSessionID, identity)
	}
	slog.Info("agent session app-server provider Goal adopted",
		"event", "agent_session.app_server.goal.provider_adopted",
		"agent_session_id", agentSessionID,
		"operation_id", identity.operationID,
		"revision", identity.revision,
	)
}

func (a *CodexAppServerAdapter) finishProviderGoalAdoption(agentSessionID, fingerprint string) {
	if a == nil {
		return
	}
	a.mu.Lock()
	defer a.mu.Unlock()
	appSession := a.sessions[strings.TrimSpace(agentSessionID)]
	if appSession == nil {
		return
	}
	delete(appSession.providerGoalAdoptionsInFlight, strings.TrimSpace(fingerprint))
}

func (a *CodexAppServerAdapter) installProviderGoalIdentity(
	agentSessionID string,
	threadID string,
	fingerprint string,
	identity goalOperationIdentity,
) (bool, bool) {
	if a == nil || !identity.valid() {
		return false, false
	}
	a.mu.Lock()
	defer a.mu.Unlock()
	appSession := a.sessions[strings.TrimSpace(agentSessionID)]
	if appSession == nil || appSession.provenanceDegraded || appSession.threadID != strings.TrimSpace(threadID) {
		return false, false
	}
	current := goalOperationIdentity{
		operationID: appSession.goalOperationID,
		revision:    appSession.goalRevision,
		repairEpoch: appSession.goalRepairEpoch,
	}
	switch {
	case current == identity:
		return appSession.currentGoalGenerationFingerprint != strings.TrimSpace(fingerprint), true
	case current.valid() && identity.revision <= current.revision:
		slog.Warn("agent session app-server provider Goal adoption lost identity race",
			"event", "agent_session.app_server.goal.provider_adoption_superseded",
			"agent_session_id", agentSessionID,
			"current_operation_id", current.operationID,
			"adopted_operation_id", identity.operationID,
		)
		return false, false
	default:
		appSession.goalOperationID = identity.operationID
		appSession.goalRevision = identity.revision
		appSession.goalRepairEpoch = identity.repairEpoch
		return true, true
	}
}
