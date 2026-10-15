package agentruntime

import (
	"context"
	"encoding/json"
	"errors"
	"log/slog"
	"strings"
	"time"

	activityshared "agorax.local/agent-daemon/packages/agent/daemon/activity/events"
)

func (a *CodexAppServerAdapter) Cancel(ctx context.Context, session Session, reason string) ([]activityshared.Event, error) {
	reason = strings.TrimSpace(reason)
	appSession := a.getSession(session.AgentSessionID)
	if appSession == nil || appSession.client == nil {
		return nil, ErrSessionDisconnected
	}
	if activeTurn := a.sessionActiveTurn(session.AgentSessionID); activeTurn != nil {
		a.markRootTurnCanceled(session.AgentSessionID, activeTurn.turnID)
	}
	activeTurnID, queued := a.requestActiveTurnCancel(session.AgentSessionID)
	// Unblock any handler waiting on an approval answer first: the message
	// read loop is parked inside that handler, so the interrupt response
	// could never be dispatched otherwise.
	a.rejectPendingRequests(session.AgentSessionID, errPermissionRequestCanceled)
	// Stop pauses an active goal BEFORE interrupting the turn: otherwise codex
	// would immediately auto-start the next goal turn and the stop would be a
	// no-op from the user's perspective. Pause failures fall through to the
	// interrupt (the reducer additionally interrupts unowned turns for paused
	// goals as defense-in-depth).
	events := a.pauseActiveGoalForCancel(session)
	if activeTurnID == "" {
		if queued {
			return events, nil
		}
		return nil, ErrSessionNoActiveTurn
	}
	appTurn := a.sessionActiveTurn(session.AgentSessionID)
	return events, a.interruptActiveTurn(ctx, appSession, session, appTurn, activeTurnID, reason)
}

func (a *CodexAppServerAdapter) CancelTargets(ctx context.Context, rootSession Session, targets []CancelTarget, reason string) (TargetedCancelResult, error) {
	rootRequested := false
	var rootTarget CancelTarget
	childTargets := make([]CancelTarget, 0, len(targets))
	for _, target := range targets {
		if strings.TrimSpace(target.AgentSessionID) == strings.TrimSpace(rootSession.AgentSessionID) {
			rootRequested = true
			rootTarget = target
			continue
		}
		childTargets = append(childTargets, target)
	}
	if rootRequested {
		a.markRootTurnCanceled(rootSession.AgentSessionID, rootTarget.TurnID)
	}
	// Stop the root provider turn before waiting for child RPCs. A slow child
	// interrupt must not leave the root alive long enough to launch more
	// provider-native children after the user's cancellation. Normal root
	// interruption keeps the app-server connection and child handles alive;
	// force-close already terminates the whole provider process.
	var rootEvents []activityshared.Event
	var rootErr error
	if rootRequested {
		rootEvents, rootErr = a.Cancel(ctx, rootSession, reason)
	}
	events, confirmedChildren := a.interruptTargetedChildTurns(rootSession, childTargets, reason)
	result := TargetedCancelResult{Events: events, ConfirmedTargets: confirmedChildren}
	if rootRequested {
		if rootErr != nil && !errors.Is(rootErr, ErrSessionNoActiveTurn) {
			result.Events = append(result.Events, rootEvents...)
			return result, rootErr
		}
		result.Events = append(result.Events, rootEvents...)
		if rootErr == nil {
			result.ConfirmedTargets = append(result.ConfirmedTargets, rootTarget)
		}
		if rootErr == nil || len(result.ConfirmedTargets) > 0 {
			return result, nil
		}
		return result, rootErr
	}
	if len(result.ConfirmedTargets) > 0 {
		return result, nil
	}
	return result, ErrSessionNoActiveTurn
}

// pauseActiveGoalForCancel sets an active goal to paused so codex stops
// auto-continuing after the interrupted turn. Best-effort: on failure the
// interrupt still proceeds and the reducer's paused-goal defense interrupts
// any turn codex starts anyway.
func (a *CodexAppServerAdapter) pauseActiveGoalForCancel(session Session) []activityshared.Event {
	agentSessionID := session.AgentSessionID
	appSession := a.getSession(agentSessionID)
	if appSession == nil || appSession.client == nil {
		return nil
	}
	if strings.TrimSpace(asString(a.sessionGoal(agentSessionID)["status"])) != "active" {
		return nil
	}
	client := appSession.client
	// Cancel's own ctx can be short-lived; bound the pause independently.
	// NoHandler: the turn being canceled is still streaming, so this RPC must
	// not claim the message handler slot (or serialize behind turn/start).
	pauseCtx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	result, err := client.ThreadGoalSetNoHandler(pauseCtx, map[string]any{
		"threadId": appSession.threadID,
		"status":   "paused",
	})
	if err != nil {
		slog.Warn("agent session app-server goal pause on cancel failed",
			"event", "agent_session.app_server.goal.pause_failed",
			"agent_session_id", agentSessionID,
			"error", err.Error(),
		)
		return nil
	}
	if goal := appServerGoalFromResult(result); len(goal) > 0 {
		a.applyGoalUpdate(agentSessionID, goal)
	} else if goal := a.sessionGoal(agentSessionID); len(goal) > 0 {
		// Status-only set may return an empty goal payload; mirror the pause
		// locally so the reducer's paused-goal defense engages.
		goal["status"] = "paused"
		a.applyGoalUpdate(agentSessionID, goal)
	}
	// No transcript notice: pausing is a deliberate action and the banner
	// already reflects the paused state; repeated stops would spam the
	// timeline.
	events := []activityshared.Event{}
	if event, ok := normalizedGoalUpdatedEvent(session, "thread_goal_update"); ok {
		events = append(events, event)
	}
	return events
}

// interruptActiveTurn stops the active turn. It first asks codex to cancel
// gracefully via turn/interrupt; if the turn has not terminated within the
// grace window it force-closes the app-server process so the turn can never
// hang forever. It returns only after the turn has actually terminated
// (terminate-then-respond), so the caller's UI can clear its stopping state
// against a real outcome.
func (a *CodexAppServerAdapter) interruptActiveTurn(
	ctx context.Context,
	appSession *codexAppServerSession,
	session Session,
	appTurn *codexAppServerActiveTurn,
	activeTurnID string,
	reason string,
) error {
	// Best-effort graceful interrupt, sent asynchronously: a wedged codex may
	// never answer turn/interrupt, and a synchronous call would burn the whole
	// acpPermissionModeTimeout before the grace window even starts. Firing it in
	// the background keeps time-to-force bounded by cancelGraceWindow.
	go a.sendTurnInterrupt(appSession, session, activeTurnID, reason)

	// Without a turn handle we cannot wait for termination or force-close.
	if appTurn == nil {
		return nil
	}

	grace := a.cancelGraceWindow
	if grace <= 0 {
		grace = defaultCodexAppServerCancelGraceWindow
	}
	timer := time.NewTimer(grace)
	defer timer.Stop()
	select {
	case <-appTurn.terminated:
		// codex honored the interrupt; the turn finished gracefully.
		return nil
	case <-timer.C:
	}

	// codex did not stop in time — force-close the app-server process. The torn
	// down connection unblocks awaitTurnCompletion via client.Done(), and the
	// force-canceled flag makes Exec surface the outcome as canceled.
	a.markTurnForceCanceled(appTurn)
	slog.Warn("agent session app-server force-closing wedged turn",
		"event", "agent_session.app_server.interrupt.forced",
		"agent_session_id", session.AgentSessionID,
		"provider_session_id", appSession.threadID,
		"turn_id", activeTurnID,
		"reason", reason,
		"grace_ms", grace.Milliseconds(),
	)
	_ = appSession.client.Close()

	// Wait for the turn goroutine to finalize so we respond after it stopped.
	select {
	case <-appTurn.terminated:
	case <-ctx.Done():
	}
	return nil
}

// sendTurnInterrupt issues a best-effort turn/interrupt. It is called in the
// background so a hung interrupt RPC cannot delay the force-close grace window.
func (a *CodexAppServerAdapter) sendTurnInterrupt(
	appSession *codexAppServerSession,
	session Session,
	activeTurnID string,
	reason string,
) {
	a.sendThreadInterrupt(appSession.client, session, appSession.threadID, activeTurnID, reason)
}

// scheduleChildNicknameFetches resolves spawned child sessions' display names.
// codex assigns each spawned agent an agentNickname on its Thread object but
// never pushes it (no thread/name/updated for children), so we fetch it
// asynchronously via thread/read and update the child session title.
func (a *CodexAppServerAdapter) scheduleChildNicknameFetches(session Session, childThreadIDs []string) {
	if a == nil || len(childThreadIDs) == 0 {
		return
	}
	appSession := a.getSession(session.AgentSessionID)
	if appSession == nil || appSession.client == nil {
		return
	}
	client := appSession.client
	for _, childThreadID := range childThreadIDs {
		go a.fetchChildThreadNickname(client, session, childThreadID)
	}
}

func (a *CodexAppServerAdapter) fetchChildThreadNickname(client *codexAppServerClient, session Session, childThreadID string) {
	childThreadID = strings.TrimSpace(childThreadID)
	if client == nil || childThreadID == "" {
		return
	}
	// The nickname can be assigned slightly after the spawn item announces the
	// thread; retry a few times before giving up (numbered fallback remains).
	for attempt := 0; attempt < 5; attempt++ {
		if attempt > 0 {
			select {
			case <-client.Done():
				return
			case <-time.After(2 * time.Second):
			}
		}
		ctx, cancel := context.WithTimeout(context.Background(), acpStartCallTimeout)
		raw, err := client.ThreadReadNoHandler(ctx, acpStartCallTimeout, map[string]any{
			"threadId": childThreadID,
		})
		cancel()
		if err != nil {
			continue
		}
		result := map[string]any{}
		_ = json.Unmarshal(raw, &result)
		thread := payloadObject(result["thread"])
		nickname := firstNonEmpty(asString(thread["agentNickname"]), asString(thread["name"]))
		if nickname == "" {
			continue
		}
		child, ok := a.appServerChildThread(session.AgentSessionID, childThreadID)
		if !ok {
			return
		}
		childSession := appServerChildSession(session, childThreadID, child)
		eventCtx, ok := appServerChildEventContext(childSession, child, "child-session-title:"+child.agentSessionID)
		if !ok {
			return
		}
		eventCtx.Title = nickname
		event := activityshared.NewSessionTitleUpdated(eventCtx)
		a.emitSessionEvents(session.AgentSessionID, []activityshared.Event{event})
		return
	}
}

func (*CodexAppServerAdapter) sendThreadInterrupt(
	client *codexAppServerClient,
	session Session,
	threadID string,
	turnID string,
	reason string,
) bool {
	threadID = strings.TrimSpace(threadID)
	if client == nil || threadID == "" {
		return false
	}
	turnID = strings.TrimSpace(turnID)
	err := codexSendTurnInterruptOnce(client, threadID, turnID)
	if err != nil {
		// Our own turn bookkeeping settles a turn locally as soon as its Go
		// context is canceled (see Cancel/interruptActiveTurn), without
		// waiting for the app-server to actually confirm the turn stopped.
		// When a slow-to-terminate tool call (for example wait_agent on
		// several dispatched sub-agents) keeps the app-server's real turn
		// alive past that point, a subsequent interrupt aimed at the turn id
		// we *think* is active gets rejected with "expected active turn id X
		// but found Y". Retry once against Y so the real, still-running turn
		// actually gets interrupted instead of being abandoned to die on its
		// own — which otherwise can leave it running for minutes.
		if foundTurnID, ok := codexExpectedActiveTurnIDMismatch(err); ok && foundTurnID != turnID {
			slog.Warn("agent session app-server interrupt turn id stale, retrying",
				"event", "agent_session.app_server.interrupt.turn_id_stale",
				"agent_session_id", session.AgentSessionID,
				"provider_session_id", threadID,
				"requested_turn_id", turnID,
				"actual_turn_id", foundTurnID,
				"reason", reason,
			)
			err = codexSendTurnInterruptOnce(client, threadID, foundTurnID)
		}
	}
	if err != nil {
		slog.Warn("agent session app-server interrupt failed",
			"event", "agent_session.app_server.interrupt.failed",
			"agent_session_id", session.AgentSessionID,
			"provider_session_id", threadID,
			"turn_id", turnID,
			"reason", reason,
			"error", err.Error(),
		)
	}
	return err == nil
}

func codexSendTurnInterruptOnce(client *codexAppServerClient, threadID, turnID string) error {
	interruptCtx, cancel := context.WithTimeout(context.Background(), acpPermissionModeTimeout)
	defer cancel()
	_, err := client.TurnInterruptNoHandler(interruptCtx, acpPermissionModeTimeout, map[string]any{
		"threadId": threadID,
		"turnId":   turnID,
	})
	return err
}

// codexExpectedActiveTurnIDMismatch recognizes the codex app-server's
// turn/interrupt rejection for a stale expected turn id: "expected active
// turn id <requested> but found <actual>". It reports actual so the caller
// can retry against the turn codex itself considers active. JSON-RPC -32600
// is the generic "invalid request" code the app-server reuses for several
// distinct rejections (see isACPProviderSessionNotFound), so this keys off
// the distinctive message text rather than the code.
func codexExpectedActiveTurnIDMismatch(err error) (string, bool) {
	var callErr *acpCallError
	if !errors.As(err, &callErr) || callErr == nil {
		return "", false
	}
	message := strings.TrimSpace(callErr.Err.Message)
	lower := strings.ToLower(message)
	if !strings.Contains(lower, "expected active turn id") {
		return "", false
	}
	const marker = "but found "
	idx := strings.LastIndex(lower, marker)
	if idx < 0 {
		return "", false
	}
	rest := strings.TrimSpace(message[idx+len(marker):])
	if sp := strings.IndexAny(rest, " \t\n"); sp >= 0 {
		rest = rest[:sp]
	}
	rest = strings.Trim(rest, ".,;")
	if rest == "" {
		return "", false
	}
	return rest, true
}

func (a *CodexAppServerAdapter) interruptTargetedChildTurns(
	session Session,
	targets []CancelTarget,
	reason string,
) ([]activityshared.Event, []CancelTarget) {
	if a == nil || len(targets) == 0 {
		return nil, nil
	}
	appSession := a.getSession(session.AgentSessionID)
	if appSession == nil || appSession.client == nil {
		return nil, nil
	}
	events := make([]activityshared.Event, 0, len(targets))
	type confirmation struct {
		target    CancelTarget
		confirmed bool
	}
	confirmations := make(chan confirmation, len(targets))
	found := 0
	for _, target := range targets {
		childThreadID, context, ok := a.appServerChildThreadByAgentSessionID(session.AgentSessionID, target.AgentSessionID)
		if !ok {
			continue
		}
		found++
		go func(target CancelTarget, childThreadID string) {
			confirmations <- confirmation{
				target:    target,
				confirmed: a.sendThreadInterrupt(appSession.client, session, childThreadID, "", reason),
			}
		}(target, childThreadID)
		childSession := appServerChildSession(session, childThreadID, context)
		eventContext, ok := appServerChildEventContext(childSession, context, "child-turn-cancel-requested:"+context.turnID)
		if !ok {
			continue
		}
		event := activityshared.NewTurnUpdated(eventContext, context.turnID, activityshared.TurnPhaseWaiting)
		event.Payload.Metadata = map[string]any{"cancelRequested": true}
		events = append(events, event)
	}
	confirmed := make([]CancelTarget, 0, found)
	for range found {
		confirmation := <-confirmations
		if confirmation.confirmed {
			confirmed = append(confirmed, confirmation.target)
		}
	}
	return events, confirmed
}

func (a *CodexAppServerAdapter) appServerChildThreadByAgentSessionID(rootAgentSessionID string, agentSessionID string) (string, *codexAppServerThreadContext, bool) {
	if a == nil {
		return "", nil, false
	}
	a.mu.Lock()
	defer a.mu.Unlock()
	appSession := a.sessions[strings.TrimSpace(rootAgentSessionID)]
	if appSession == nil {
		return "", nil, false
	}
	for childThreadID, child := range appSession.childThreads {
		if child != nil && strings.TrimSpace(child.agentSessionID) == strings.TrimSpace(agentSessionID) {
			copy := *child
			return childThreadID, &copy, true
		}
	}
	return "", nil, false
}

func (a *CodexAppServerAdapter) markTurnForceCanceled(turn *codexAppServerActiveTurn) {
	if a == nil || turn == nil {
		return
	}
	a.mu.Lock()
	turn.forceCanceled = true
	agentSessionID := turn.session.AgentSessionID
	emits := turn.settleEmits && !turn.phase.terminal()
	turn.phase = codexAppServerTurnPhaseCanceled
	a.mu.Unlock()
	terminal := codexAppServerTurnTerminal{err: errPermissionRequestCanceled, phase: codexAppServerTurnPhaseCanceled}
	select {
	case turn.terminal <- terminal:
	default:
	}
	// Force-cancel is a first-class terminal transition: finalize from here
	// so terminal events do not depend on the (possibly wedged) shell.
	if emits {
		a.finalizeSettledTurn(agentSessionID, turn, terminal)
	}
}

func (a *CodexAppServerAdapter) turnForceCanceled(turn *codexAppServerActiveTurn) bool {
	if a == nil || turn == nil {
		return false
	}
	a.mu.Lock()
	defer a.mu.Unlock()
	return turn.forceCanceled
}

func (a *CodexAppServerAdapter) interruptActiveTurnAsync(
	appSession *codexAppServerSession,
	session Session,
	appTurn *codexAppServerActiveTurn,
	activeTurnID string,
	reason string,
) {
	go func() {
		if err := a.interruptActiveTurn(context.Background(), appSession, session, appTurn, activeTurnID, reason); err != nil {
			slog.Warn("agent session app-server queued interrupt failed",
				"event", "agent_session.app_server.interrupt.queued_failed",
				"agent_session_id", session.AgentSessionID,
				"provider_session_id", appSession.threadID,
				"turn_id", activeTurnID,
				"reason", reason,
				"error", err.Error(),
			)
		}
	}()
}
