package agentruntime

import (
	"context"
	"errors"
	"strings"

	activityshared "agorax.local/agent-daemon/packages/agent/daemon/activity/events"
)

type codexGuidanceContinuationAdmission struct {
	providerTurnID     string
	admitted           chan error
	provisionalStarted chan struct{}
}

func newCodexGuidanceContinuationAdmission(providerTurnID string) *codexGuidanceContinuationAdmission {
	return &codexGuidanceContinuationAdmission{
		providerTurnID:     providerTurnID,
		admitted:           make(chan error, 1),
		provisionalStarted: make(chan struct{}),
	}
}

func (a *codexGuidanceContinuationAdmission) published() bool {
	if a == nil {
		return false
	}
	select {
	case <-a.provisionalStarted:
		return true
	default:
		return false
	}
}

func (a *CodexAppServerAdapter) execAsync(
	ctx context.Context,
	session Session,
	content []PromptContentBlock,
	displayPrompt string,
	turnID string,
	emit EventSink,
	emitCommands CommandSnapshotSink,
	continuation *codexGuidanceContinuationAdmission,
) error {
	go func() {
		events, err := a.execBlocking(
			ctx,
			session,
			content,
			displayPrompt,
			turnID,
			emit,
			emitCommands,
			codexTurnExecOptions{continuation: continuation},
		)
		if continuation != nil && !continuation.published() {
			return
		}
		if emit == nil {
			return
		}
		outcome := codexAsyncTerminalOutcome(events, err)
		terminalEvents := make([]activityshared.Event, 0, 2)
		if continuation != nil &&
			!codexAsyncProviderLifecycleSupersedes(events, continuation.providerTurnID) {
			metadata := map[string]any{
				"guidanceContinuation": true,
				"providerTurnStarted":  false,
			}
			if err != nil {
				metadata["error"] = err.Error()
			}
			terminalEvents = append(terminalEvents, appServerRootProviderTurnCompletedEvent(
				session,
				turnID,
				continuation.providerTurnID,
				outcome,
				metadata,
			))
		}
		if err != nil {
			if outcome == activityshared.TurnOutcomeCanceled {
				terminalEvents = append(terminalEvents, newTurnActivityEvent(session, EventTurnCanceled, turnID, SessionStatusCanceled, "", "", map[string]any{
					"error": err.Error(),
				}))
			} else {
				terminalEvents = append(terminalEvents, newTurnActivityEvent(session, EventTurnFailed, turnID, SessionStatusFailed, "", "", acpFailureMetadata(err)))
			}
		}
		if len(terminalEvents) > 0 {
			emit(terminalEvents)
		}
	}()
	return nil
}

func codexAsyncProviderLifecycleSupersedes(events []activityshared.Event, provisionalProviderTurnID string) bool {
	for _, event := range events {
		if event.Type != activityshared.EventRootProviderTurnStarted &&
			event.Type != activityshared.EventRootProviderTurnCompleted {
			continue
		}
		providerTurnID := strings.TrimSpace(event.Payload.ProviderTurnID)
		if providerTurnID != "" && providerTurnID != provisionalProviderTurnID {
			return true
		}
	}
	return false
}

func codexAsyncTerminalOutcome(events []activityshared.Event, err error) activityshared.TurnOutcome {
	if errors.Is(err, context.Canceled) {
		return activityshared.TurnOutcomeCanceled
	}
	for _, event := range events {
		switch event.Type {
		case activityshared.EventTurnCanceled:
			return activityshared.TurnOutcomeCanceled
		case activityshared.EventTurnFailed:
			return activityshared.TurnOutcomeFailed
		}
	}
	if err != nil {
		return activityshared.TurnOutcomeFailed
	}
	return activityshared.TurnOutcomeCompleted
}
