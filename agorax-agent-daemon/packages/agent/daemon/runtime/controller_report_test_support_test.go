package agentruntime

import (
	"context"
	"fmt"
	"sync"
	"testing"
	"time"

	agentsessionstore "agorax.local/agent-daemon/packages/agent/daemon/activity"
	activityshared "agorax.local/agent-daemon/packages/agent/daemon/activity/events"
)

type recordingReporter struct {
	mu      sync.Mutex
	calls   []reportCall
	updates chan struct{}
}

type reportCall struct {
	report agentsessionstore.ReportActivityInput
}

func (r *recordingReporter) Report(_ context.Context, report agentsessionstore.ReportActivityInput) error {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.calls = append(r.calls, reportCall{report: report})
	if r.updates != nil {
		select {
		case r.updates <- struct{}{}:
		default:
		}
	}
	return nil
}

func (r *recordingReporter) ReportSubmitProvenance(ctx context.Context, report agentsessionstore.ReportActivityInput) error {
	return r.Report(ctx, report)
}

func (r *recordingReporter) snapshot() []reportCall {
	r.mu.Lock()
	defer r.mu.Unlock()
	return append([]reportCall(nil), r.calls...)
}

func (r *recordingReporter) waitForCalls(t *testing.T, count int) []reportCall {
	t.Helper()
	return r.waitForReports(t, fmt.Sprintf("at least %d report calls", count), func(calls []reportCall) bool {
		return len(calls) >= count
	})
}

func (r *recordingReporter) waitForReports(
	t *testing.T,
	description string,
	matches func([]reportCall) bool,
) []reportCall {
	t.Helper()
	timer := time.NewTimer(10 * time.Second)
	defer timer.Stop()
	for {
		r.mu.Lock()
		calls := append([]reportCall(nil), r.calls...)
		if matches(calls) {
			r.mu.Unlock()
			return calls
		}
		if r.updates == nil {
			r.updates = make(chan struct{}, 1)
		}
		updates := r.updates
		r.mu.Unlock()
		select {
		case <-updates:
		case <-timer.C:
			t.Fatalf("timed out waiting for %s; report calls = %d", description, len(calls))
		}
	}
}

func hasActivityMessage(events []activityshared.Event, role activityshared.MessageRole, content string) bool {
	for _, event := range events {
		if event.Type != activityshared.EventMessageAppended {
			continue
		}
		if role != "" && event.Payload.Role != role {
			continue
		}
		if event.Payload.Content == content {
			return true
		}
	}
	return false
}

func reportInputs(calls []reportCall) []agentsessionstore.ReportActivityInput {
	out := make([]agentsessionstore.ReportActivityInput, 0, len(calls))
	for _, call := range calls {
		out = append(out, call.report)
	}
	return out
}

func hasTimelineItem(report agentsessionstore.ReportActivityInput, itemType string, status string, text string) bool {
	for _, update := range report.MessageUpdates {
		if !messageUpdateMatchesLegacyItemType(update, itemType) {
			continue
		}
		if status != "" && update.Status != status && asString(update.Payload["status"]) != status {
			continue
		}
		if text != "" && update.Payload["text"] != text {
			continue
		}
		return true
	}
	return false
}

func hasTimelineItemWithCallType(report agentsessionstore.ReportActivityInput, itemType string, callType string, status string) bool {
	for _, update := range report.MessageUpdates {
		if !messageUpdateMatchesLegacyItemType(update, itemType) {
			continue
		}
		if callType != "" && asString(update.Payload["callType"]) != callType {
			continue
		}
		if status != "" && update.Status != status {
			continue
		}
		return true
	}
	return false
}

func reportWithTimelineItem(reports []agentsessionstore.ReportActivityInput, itemType string) (agentsessionstore.ReportActivityInput, bool) {
	for _, report := range reports {
		if hasTimelineItem(report, itemType, "", "") {
			return report, true
		}
	}
	return agentsessionstore.ReportActivityInput{}, false
}

func messageUpdateMatchesLegacyItemType(update agentsessionstore.WorkspaceAgentMessageUpdate, itemType string) bool {
	switch itemType {
	case "message.user":
		return update.Kind == "text" && update.Role == "user"
	case "message.assistant":
		return update.Kind == "text" && update.Role == "assistant"
	case "message.assistant_thinking":
		return update.Kind == "reasoning" && update.Role == "assistant"
	case "call.started":
		return update.Kind == "tool_call" && update.CompletedAtUnixMS == 0
	case "call.completed":
		return update.Kind == "tool_call" && update.Status == "completed"
	case "call.errored":
		return update.Kind == "tool_call" && update.Status == "failed"
	default:
		return false
	}
}

func hasTurnCompletionPatch(report agentsessionstore.ReportActivityInput, turnID string) bool {
	for _, patch := range report.StatePatches {
		if patch.Turn != nil &&
			patch.Turn.TurnID == turnID &&
			patch.Turn.CompletedAtUnixMS > 0 {
			return true
		}
	}
	return false
}

func hasTurnCompletionPatchInReports(reports []agentsessionstore.ReportActivityInput, turnID string) bool {
	for _, report := range reports {
		if hasTurnCompletionPatch(report, turnID) {
			return true
		}
	}
	return false
}
