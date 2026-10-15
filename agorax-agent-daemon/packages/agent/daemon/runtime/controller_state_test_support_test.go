package agentruntime

import (
	"context"
	"strings"

	activityshared "agorax.local/agent-daemon/packages/agent/daemon/activity/events"
)

type statefulInteractiveAdapter struct {
	provider            string
	snapshot            SessionStateSnapshot
	commandSnapshot     AgentSessionCommandSnapshot
	hasCommands         bool
	commandSink         CommandSnapshotSink
	interactiveInput    SubmitInteractiveInput
	interactiveOptionID string
	submitHook          func(Session)
	applySettingsErr    error
	appliedSettings     []SessionSettingsPatch
	configSink          ConfigOptionsUpdateSink
	requiresNewSession  bool
}

func (a *statefulInteractiveAdapter) Provider() string {
	if a != nil && strings.TrimSpace(a.provider) != "" {
		return strings.TrimSpace(a.provider)
	}
	return ProviderCodex
}

func (*statefulInteractiveAdapter) Start(_ context.Context, session Session) ([]activityshared.Event, error) {
	return []activityshared.Event{
		newSessionActivityEvent(session, EventSessionStarted, SessionStatusReady, nil),
	}, nil
}

func (*statefulInteractiveAdapter) Resume(context.Context, Session) error { return nil }

func (*statefulInteractiveAdapter) Close(context.Context, Session) error {
	return nil
}

func (*statefulInteractiveAdapter) Exec(context.Context, Session, []PromptContentBlock, string, string, EventSink, CommandSnapshotSink) ([]activityshared.Event, error) {
	return nil, nil
}

func (*statefulInteractiveAdapter) Cancel(context.Context, Session, string) ([]activityshared.Event, error) {
	return nil, nil
}

func (a *statefulInteractiveAdapter) SessionState(Session) SessionStateSnapshot {
	return a.snapshot
}

func (a *statefulInteractiveAdapter) SessionCommandSnapshot(Session) (AgentSessionCommandSnapshot, bool) {
	return a.commandSnapshot, a.hasCommands
}

func (a *statefulInteractiveAdapter) SetCommandSnapshotSink(sink CommandSnapshotSink) {
	a.commandSink = sink
}

func (a *statefulInteractiveAdapter) SetConfigOptionsUpdateSink(sink ConfigOptionsUpdateSink) {
	a.configSink = sink
}

func (a *statefulInteractiveAdapter) SubmitInteractive(_ context.Context, session Session, input SubmitInteractiveInput) (SubmitInteractiveResult, error) {
	a.interactiveInput = input
	optionID := a.interactiveOptionID
	if optionID == "" {
		optionID = input.OptionID
	}
	if a.submitHook != nil {
		a.submitHook(session)
	}
	return SubmitInteractiveResult{
		AgentSessionID: session.AgentSessionID,
		RequestID:      input.RequestID,
		Accepted:       true,
		OptionID:       optionID,
	}, nil
}

func (a *statefulInteractiveAdapter) StateAfterInteractiveSelection(
	_ Session,
	optionID string,
) (InteractiveSelectionState, bool) {
	if a.Provider() != ProviderClaudeCode {
		return InteractiveSelectionState{}, false
	}
	planMode, permissionMode, ok := claudeCodeModeFromID(optionID)
	return InteractiveSelectionState{
		PlanMode:       planMode,
		PermissionMode: permissionMode,
	}, ok
}

func (a *statefulInteractiveAdapter) ApplySessionSettings(_ context.Context, session Session, patch SessionSettingsPatch) error {
	if a.applySettingsErr != nil {
		return a.applySettingsErr
	}
	a.appliedSettings = append(a.appliedSettings, patch)
	if a.snapshot.Settings == nil {
		a.snapshot.Settings = cloneSessionSettings(
			normalizeSessionSettings(session.Settings, session.Provider, session.PermissionModeID),
		)
		if a.snapshot.PermissionModeID == "" {
			a.snapshot.PermissionModeID = session.PermissionModeID
		}
	}
	if patch.Model != nil {
		a.snapshot.Settings.Model = *patch.Model
	}
	if patch.ReasoningEffort != nil {
		a.snapshot.Settings.ReasoningEffort = *patch.ReasoningEffort
	}
	if patch.Speed != nil {
		a.snapshot.Settings.Speed = *patch.Speed
	}
	if patch.PlanMode != nil {
		a.snapshot.Settings.PlanMode = *patch.PlanMode
	}
	if patch.PermissionModeID != nil {
		a.snapshot.Settings.PermissionModeID = *patch.PermissionModeID
		a.snapshot.PermissionModeID = *patch.PermissionModeID
	}
	return nil
}

func (a *statefulInteractiveAdapter) RequiresNewSessionForSettings(Session, SessionSettingsPatch) bool {
	return a.requiresNewSession
}
