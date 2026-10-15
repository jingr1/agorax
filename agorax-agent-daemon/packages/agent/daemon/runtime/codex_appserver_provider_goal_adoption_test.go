package agentruntime

import (
	"context"
	"sync"
	"testing"
	"time"
)

func TestCodexProviderNativeGoalAdoptionProvesAutomaticContinuation(t *testing.T) {
	t.Parallel()

	adapter, transport, session := startedAppServerAdapter(t)
	adapter.goalProvenanceGraceWindow = 10 * time.Millisecond
	controller := NewController([]Adapter{adapter}, nil)
	adapter.SetGoalProvenanceDurableSink(&memoryGoalProvenanceLedger{
		bindings: make(map[string]GoalProvenanceBinding),
	})
	var (
		adoptionMu sync.Mutex
		requests   []ProviderGoalAdoptionRequest
	)
	controller.SetProviderGoalAdoptionSink(func(
		_ context.Context,
		gotSession Session,
		request ProviderGoalAdoptionRequest,
	) (GoalProvenanceBinding, error) {
		if gotSession.RoomID != session.RoomID ||
			gotSession.AgentSessionID != session.AgentSessionID ||
			gotSession.ProviderSessionID != session.ProviderSessionID {
			t.Errorf("adoption session = %#v", gotSession)
		}
		adoptionMu.Lock()
		requests = append(requests, request)
		adoptionMu.Unlock()
		return GoalProvenanceBinding{OperationID: "provider-goal-operation", Revision: 1}, nil
	})
	goal := map[string]any{
		"threadId": session.ProviderSessionID, "objective": "count from one to five",
		"status": "active", "createdAt": int64(100), "updatedAt": int64(101),
	}

	transport.conn.notify(appServerNotifyThreadGoalUpdated, map[string]any{
		"threadId": session.ProviderSessionID,
		"goal":     goal,
	})
	transport.conn.notify(appServerNotifyTurnStarted, map[string]any{
		"threadId": session.ProviderSessionID,
		"turn": map[string]any{
			"id": "provider-native-goal-turn", "status": "inProgress", "items": []any{},
		},
	})

	waitForCondition(t, func() bool {
		active := adapter.sessionActiveTurn(session.AgentSessionID)
		return active != nil &&
			adapter.sessionActiveTurnID(session.AgentSessionID) == "provider-native-goal-turn" &&
			active.goalIdentity.operationID == "provider-goal-operation" &&
			active.goalIdentity.revision == 1 &&
			active.goalProvenance == "ordered_goal_continuation_claim"
	})
	adoptionMu.Lock()
	if len(requests) != 1 ||
		requests[0].Fingerprint != codexGoalGenerationFingerprint(goal) ||
		requests[0].ExpectedRevision != 0 ||
		asString(requests[0].Goal["objective"]) != "count from one to five" {
		t.Fatalf("adoption requests = %#v", requests)
	}
	adoptionMu.Unlock()
	if interrupts := appServerRequestParamsList(t, transport.conn, appServerMethodTurnInterrupt); len(interrupts) != 0 {
		t.Fatalf("provider-native Goal continuation was interrupted: %#v", interrupts)
	}
}

func TestCodexCurrentGoalProgressBindsWithoutProviderAdoption(t *testing.T) {
	t.Parallel()

	adapter, transport, session := startedAppServerAdapter(t)
	controller := NewController([]Adapter{adapter}, nil)
	ledger := &memoryGoalProvenanceLedger{bindings: make(map[string]GoalProvenanceBinding)}
	adapter.SetGoalProvenanceDurableSink(ledger)
	var (
		adoptionMu sync.Mutex
		requests   []ProviderGoalAdoptionRequest
	)
	controller.SetProviderGoalAdoptionSink(func(
		_ context.Context,
		_ Session,
		request ProviderGoalAdoptionRequest,
	) (GoalProvenanceBinding, error) {
		adoptionMu.Lock()
		requests = append(requests, request)
		adoptionMu.Unlock()
		return GoalProvenanceBinding{OperationID: "unexpected-adoption", Revision: 4}, nil
	})
	identity := goalOperationIdentity{operationID: "goal-operation-current", revision: 3}
	adapter.replaceGoalOperationIdentity(session.AgentSessionID, identity.operationID, identity.revision, 0)
	first := map[string]any{
		"threadId": session.ProviderSessionID, "objective": "finish current work",
		"status": "active", "createdAt": int64(100), "updatedAt": int64(101),
	}
	adapter.applyGoalUpdate(session.AgentSessionID, first)
	if err := adapter.bindGoalGeneration(context.Background(), session, first, identity); err != nil {
		t.Fatal(err)
	}
	progress := clonePayload(first)
	progress["updatedAt"] = int64(102)
	progress["timeUsedSeconds"] = int64(1)
	transport.conn.notify(appServerNotifyThreadGoalUpdated, map[string]any{
		"threadId": session.ProviderSessionID, "goal": progress,
	})
	progressFingerprint := codexGoalGenerationFingerprint(progress)
	waitForCondition(t, func() bool {
		binding, found, err := ledger.LookupGoalProvenance(context.Background(), session, progressFingerprint)
		return err == nil && found && binding.OperationID == identity.operationID && binding.Revision == identity.revision
	})
	adoptionMu.Lock()
	defer adoptionMu.Unlock()
	if len(requests) != 0 {
		t.Fatalf("current Goal progress entered provider adoption: %#v", requests)
	}
}

func TestCodexClearedGoalIgnoresLateGenerationUpdate(t *testing.T) {
	t.Parallel()

	adapter, transport, session := startedAppServerAdapter(t)
	controller := NewController([]Adapter{adapter}, nil)
	adapter.SetGoalProvenanceDurableSink(&memoryGoalProvenanceLedger{
		bindings: make(map[string]GoalProvenanceBinding),
	})
	var (
		adoptionMu sync.Mutex
		requests   []ProviderGoalAdoptionRequest
	)
	controller.SetProviderGoalAdoptionSink(func(
		_ context.Context,
		_ Session,
		request ProviderGoalAdoptionRequest,
	) (GoalProvenanceBinding, error) {
		adoptionMu.Lock()
		requests = append(requests, request)
		adoptionMu.Unlock()
		return GoalProvenanceBinding{OperationID: "unexpected-adoption", Revision: 5}, nil
	})
	owner := goalOperationIdentity{operationID: "goal-operation-owner", revision: 3}
	adapter.replaceGoalOperationIdentity(session.AgentSessionID, owner.operationID, owner.revision, 0)
	goal := map[string]any{
		"threadId": session.ProviderSessionID, "objective": "finish current work",
		"status": "active", "createdAt": int64(200), "updatedAt": int64(201),
	}
	adapter.applyGoalUpdate(session.AgentSessionID, goal)
	if err := adapter.bindGoalGeneration(context.Background(), session, goal, owner); err != nil {
		t.Fatal(err)
	}
	adapter.replaceGoalOperationIdentity(session.AgentSessionID, "goal-operation-clear", 4, 0)
	adapter.applyGoalClear(session.AgentSessionID)
	late := clonePayload(goal)
	late["updatedAt"] = int64(202)
	late["timeUsedSeconds"] = int64(1)
	transport.conn.notify(appServerNotifyThreadGoalUpdated, map[string]any{
		"threadId": session.ProviderSessionID, "goal": late,
	})
	time.Sleep(50 * time.Millisecond)
	if got := adapter.sessionGoal(session.AgentSessionID); len(got) != 0 {
		t.Fatalf("late provider update revived cleared Goal: %#v", got)
	}
	adoptionMu.Lock()
	defer adoptionMu.Unlock()
	if len(requests) != 0 {
		t.Fatalf("late cleared Goal entered provider adoption: %#v", requests)
	}
}

func TestCodexProviderAdoptionCapturesRevisionBeforeAsyncDispatch(t *testing.T) {
	t.Parallel()

	adapter, transport, session := startedAppServerAdapter(t)
	controller := NewController([]Adapter{adapter}, nil)
	var (
		adoptionMu sync.Mutex
		requests   []ProviderGoalAdoptionRequest
	)
	adoptionStarted := make(chan struct{})
	releaseAdoption := make(chan struct{})
	controller.SetProviderGoalAdoptionSink(func(
		_ context.Context,
		_ Session,
		request ProviderGoalAdoptionRequest,
	) (GoalProvenanceBinding, error) {
		close(adoptionStarted)
		<-releaseAdoption
		adoptionMu.Lock()
		requests = append(requests, request)
		adoptionMu.Unlock()
		return GoalProvenanceBinding{OperationID: "provider-operation", Revision: 4}, nil
	})
	adapter.replaceGoalOperationIdentity(session.AgentSessionID, "goal-operation-before-clear", 3, 0)
	goal := map[string]any{
		"threadId": session.ProviderSessionID, "objective": "provider-authored work",
		"status": "active", "createdAt": int64(300), "updatedAt": int64(301),
	}
	transport.conn.notify(appServerNotifyThreadGoalUpdated, map[string]any{
		"threadId": session.ProviderSessionID, "goal": goal,
	})
	select {
	case <-adoptionStarted:
	case <-time.After(time.Second):
		t.Fatal("provider adoption did not start")
	}
	adapter.replaceGoalOperationIdentity(session.AgentSessionID, "goal-operation-clear", 4, 0)
	close(releaseAdoption)
	waitForCondition(t, func() bool {
		adoptionMu.Lock()
		defer adoptionMu.Unlock()
		return len(requests) == 1
	})
	adoptionMu.Lock()
	defer adoptionMu.Unlock()
	if requests[0].ExpectedRevision != 3 {
		t.Fatalf("adoption expected revision = %d, want observation revision 3", requests[0].ExpectedRevision)
	}
}

func TestCodexProviderNativeGoalAdoptionDoesNotBlockReadLoop(t *testing.T) {
	t.Parallel()

	adapter, transport, session := startedAppServerAdapter(t)
	adapter.goalProvenanceGraceWindow = 5 * time.Millisecond
	controller := NewController([]Adapter{adapter}, nil)
	adapter.SetGoalProvenanceDurableSink(&memoryGoalProvenanceLedger{
		bindings: make(map[string]GoalProvenanceBinding),
	})
	adoptionStarted := make(chan struct{})
	releaseAdoption := make(chan struct{})
	var releaseOnce sync.Once
	t.Cleanup(func() { releaseOnce.Do(func() { close(releaseAdoption) }) })
	controller.SetProviderGoalAdoptionSink(func(
		ctx context.Context,
		_ Session,
		_ ProviderGoalAdoptionRequest,
	) (GoalProvenanceBinding, error) {
		close(adoptionStarted)
		select {
		case <-releaseAdoption:
			return GoalProvenanceBinding{OperationID: "provider-goal-slow", Revision: 1}, nil
		case <-ctx.Done():
			return GoalProvenanceBinding{}, ctx.Err()
		}
	})
	goal := map[string]any{
		"threadId": session.ProviderSessionID, "objective": "wait for durable adoption",
		"status": "active", "createdAt": int64(200), "updatedAt": int64(201),
	}

	transport.conn.notify(appServerNotifyThreadGoalUpdated, map[string]any{
		"threadId": session.ProviderSessionID,
		"goal":     goal,
	})
	select {
	case <-adoptionStarted:
	case <-time.After(time.Second):
		t.Fatal("provider Goal adoption did not start")
	}
	transport.conn.notify(appServerNotifyTurnStarted, map[string]any{
		"threadId": session.ProviderSessionID,
		"turn": map[string]any{
			"id": "provider-native-goal-slow-turn", "status": "inProgress", "items": []any{},
		},
	})
	waitForCondition(t, func() bool {
		adapter.mu.Lock()
		defer adapter.mu.Unlock()
		appSession := adapter.sessions[session.AgentSessionID]
		return appSession != nil && appSession.pendingGoalTurns["provider-native-goal-slow-turn"] != nil
	})
	time.Sleep(3 * adapter.goalProvenanceGraceWindow)
	if interrupts := appServerRequestParamsList(t, transport.conn, appServerMethodTurnInterrupt); len(interrupts) != 0 {
		t.Fatalf("in-flight adoption allowed pending turn to expire: %#v", interrupts)
	}

	releaseOnce.Do(func() { close(releaseAdoption) })
	waitForCondition(t, func() bool {
		active := adapter.sessionActiveTurn(session.AgentSessionID)
		return active != nil &&
			adapter.sessionActiveTurnID(session.AgentSessionID) == "provider-native-goal-slow-turn" &&
			active.goalIdentity.operationID == "provider-goal-slow"
	})
}

func TestCodexProviderNativeGoalAdoptionAdvancesAfterTerminalGeneration(t *testing.T) {
	t.Parallel()

	adapter, transport, session := startedAppServerAdapter(t)
	adapter.goalProvenanceGraceWindow = 10 * time.Millisecond
	adapter.goalContinuationGraceWindow = time.Hour
	controller := NewController([]Adapter{adapter}, nil)
	adapter.SetGoalProvenanceDurableSink(&memoryGoalProvenanceLedger{
		bindings: make(map[string]GoalProvenanceBinding),
	})
	var (
		adoptionMu sync.Mutex
		requests   []ProviderGoalAdoptionRequest
	)
	controller.SetProviderGoalAdoptionSink(func(
		_ context.Context,
		_ Session,
		request ProviderGoalAdoptionRequest,
	) (GoalProvenanceBinding, error) {
		adoptionMu.Lock()
		defer adoptionMu.Unlock()
		requests = append(requests, request)
		revision := int64(len(requests))
		return GoalProvenanceBinding{
			OperationID: "provider-goal-operation-" + asString(request.Goal["objective"]),
			Revision:    revision,
		}, nil
	})
	firstGoal := map[string]any{
		"threadId": session.ProviderSessionID, "objective": "first",
		"status": "active", "createdAt": int64(300), "updatedAt": int64(301),
	}
	transport.conn.notify(appServerNotifyThreadGoalUpdated, map[string]any{
		"threadId": session.ProviderSessionID, "goal": firstGoal,
	})
	transport.conn.notify(appServerNotifyTurnStarted, map[string]any{
		"threadId": session.ProviderSessionID,
		"turn": map[string]any{
			"id": "provider-native-goal-first-turn", "status": "inProgress", "items": []any{},
		},
	})
	waitForCondition(t, func() bool {
		active := adapter.sessionActiveTurn(session.AgentSessionID)
		return active != nil && active.goalIdentity.revision == 1
	})
	transport.conn.notify(appServerNotifyTurnCompleted, map[string]any{
		"threadId": session.ProviderSessionID,
		"turn": map[string]any{
			"id": "provider-native-goal-first-turn", "status": "completed", "items": []any{},
		},
	})
	waitForCondition(t, func() bool {
		return adapter.sessionActiveTurn(session.AgentSessionID) == nil
	})
	firstGoal["status"] = "complete"
	transport.conn.notify(appServerNotifyThreadGoalUpdated, map[string]any{
		"threadId": session.ProviderSessionID, "goal": firstGoal,
	})

	secondGoal := map[string]any{
		"threadId": session.ProviderSessionID, "objective": "second",
		"status": "active", "createdAt": int64(400), "updatedAt": int64(401),
	}
	transport.conn.notify(appServerNotifyThreadGoalUpdated, map[string]any{
		"threadId": session.ProviderSessionID, "goal": secondGoal,
	})
	transport.conn.notify(appServerNotifyTurnStarted, map[string]any{
		"threadId": session.ProviderSessionID,
		"turn": map[string]any{
			"id": "provider-native-goal-second-turn", "status": "inProgress", "items": []any{},
		},
	})
	waitForCondition(t, func() bool {
		active := adapter.sessionActiveTurn(session.AgentSessionID)
		return active != nil &&
			adapter.sessionActiveTurnID(session.AgentSessionID) == "provider-native-goal-second-turn" &&
			active.goalIdentity.operationID == "provider-goal-operation-second" &&
			active.goalIdentity.revision == 2
	})
	adoptionMu.Lock()
	defer adoptionMu.Unlock()
	if len(requests) != 2 {
		t.Fatalf("provider Goal adoption requests = %#v", requests)
	}
	if interrupts := appServerRequestParamsList(t, transport.conn, appServerMethodTurnInterrupt); len(interrupts) != 0 {
		t.Fatalf("later provider-native Goal continuation was interrupted: %#v", interrupts)
	}
}
