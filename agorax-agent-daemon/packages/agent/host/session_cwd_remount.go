package agenthost

import (
	"context"
	"strings"
)

// RemountSessionCwd updates the durable session cwd and replaces the live
// provider connection with a fresh Start so ACP session/new binds tools to the
// composer workspace. Canonical history is preserved; provider-side transcript
// context may reset because ACP cwd is sticky at session creation.
func (h *Host) RemountSessionCwd(ctx context.Context, input RemountSessionCwdInput) (RemountSessionCwdResult, error) {
	ref := normalizedSessionRef(SessionRef{
		WorkspaceID: input.WorkspaceID, AgentSessionID: input.AgentSessionID,
	})
	cwd := strings.TrimSpace(input.Cwd)
	if h == nil || h.store == nil || h.runtime == nil || ref.WorkspaceID == "" || ref.AgentSessionID == "" || cwd == "" {
		return RemountSessionCwdResult{}, ErrInvalidArgument
	}
	cwdStore, ok := h.store.(SessionCwdStore)
	if !ok {
		if h.sessionManagement != nil {
			cwdStore, ok = h.sessionManagement.(SessionCwdStore)
		}
	}
	if !ok {
		return RemountSessionCwdResult{}, ErrRuntimeSessionReprepareUnavailable
	}

	var result RemountSessionCwdResult
	err := h.withSessionMutationActor(ctx, ref.WorkspaceID, ref.AgentSessionID, func(actorCtx context.Context) error {
		release, acquireErr := h.acquireSession(actorCtx, ref)
		if acquireErr != nil {
			return acquireErr
		}
		defer release()

		canonical, found, getErr := h.store.GetSession(actorCtx, ref.WorkspaceID, ref.AgentSessionID)
		if getErr != nil {
			return getErr
		}
		if !found {
			return ErrSessionNotFound
		}
		if strings.TrimSpace(canonical.ActiveTurnID) != "" {
			return ErrRuntimeSessionActive
		}
		if live, liveFound := h.runtime.Session(ref.WorkspaceID, ref.AgentSessionID); liveFound {
			if runtimeSessionHasActiveTurn(live) {
				return ErrRuntimeSessionActive
			}
		}
		if strings.TrimSpace(canonical.Cwd) == cwd {
			live, runtimeFound := h.runtime.Session(ref.WorkspaceID, ref.AgentSessionID)
			liveFound := runtimeFound
			if liveness, ok := h.runtime.(RuntimeSessionLiveness); ok {
				liveFound = runtimeFound && liveness.RuntimeSessionLive(ref.WorkspaceID, ref.AgentSessionID)
			}
			result = RemountSessionCwdResult{
				Session: live, Canonical: canonical, Live: liveFound, Remounted: false,
			}
			return nil
		}

		updated, changed, updateErr := cwdStore.UpdateSessionCwd(
			actorCtx, ref.WorkspaceID, ref.AgentSessionID, cwd,
		)
		if updateErr != nil {
			return updateErr
		}
		if !changed {
			return ErrSessionNotFound
		}
		canonical = updated

		if _, liveFound := h.runtime.Session(ref.WorkspaceID, ref.AgentSessionID); liveFound {
			if closeErr := h.runtime.Close(actorCtx, RuntimeCloseInput{
				WorkspaceID: ref.WorkspaceID, AgentSessionID: ref.AgentSessionID,
				PreserveCanonicalState: true,
			}); closeErr != nil {
				return closeErr
			}
		}

		settings := composerSettingsFromMap(canonical.Settings)
		prepared := PreparedRuntime{Cwd: cwd}
		var prepErr error
		if h.preparation != nil {
			prepared, prepErr = h.preparation.Prepare(actorCtx, resumePreparationInput(canonical, settings))
			if prepErr != nil {
				return prepErr
			}
			if prepared.Settings != nil {
				settings = *prepared.Settings
			}
		}
		if prepared.Env, prepErr = runtimeEnvironmentForCanonicalSession(prepared.Env, prepared.Cwd, canonical); prepErr != nil {
			return prepErr
		}

		releaseStartup, startupErr := h.acquireStartup(actorCtx, canonical.Provider)
		if startupErr != nil {
			return startupErr
		}
		defer releaseStartup()

		startResult, startErr := h.runtime.Start(actorCtx, RuntimeStartInput{
			WorkspaceID: ref.WorkspaceID, AgentSessionID: ref.AgentSessionID,
			AgentTargetID: strings.TrimSpace(canonical.AgentTargetID),
			Provider:      strings.TrimSpace(canonical.Provider),
			Cwd:           prepared.Cwd,
			Env:           append([]string(nil), prepared.Env...),
			MCPServers:    cloneHostMCPServerBindings(prepared.MCPServers),
			Title:         strings.TrimSpace(canonical.Title),
			InitialTitleEstablished: true,
			PermissionModeID:        settings.PermissionModeID,
			Model:                   settings.Model,
			PlanMode:                settings.PlanMode,
			BrowserUse:              settings.BrowserUse,
			ComputerUse:             settings.ComputerUse,
			CodexSaverMode:          settings.CodexSaverMode,
			RTKSaverMode:            settings.RTKSaverMode,
			ProviderTargetRef:       cloneMap(prepared.ProviderTargetRef),
			RuntimeContext:          cloneMap(firstMap(prepared.RuntimeContext, canonical.InternalRuntimeContext)),
			ReasoningEffort:         settings.ReasoningEffort,
			Speed:                   settings.Speed,
			ConversationDetailMode:  settings.ConversationDetailMode,
			Visible:                 boolPointer(canonical.Metadata.Visible),
			CanonicalInitPending:    false,
		})
		if startErr != nil {
			return startErr
		}

		result = RemountSessionCwdResult{
			Session: startResult.Session, Canonical: canonical, Live: true, Remounted: true,
		}
		return nil
	})
	return result, err
}
