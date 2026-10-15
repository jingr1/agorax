package agentsessionstore

import (
	"context"
	"testing"
)

type captureSessionReporter struct {
	inputs []ReportSessionMessagesInput
}

func (*captureSessionReporter) ReportSessionState(context.Context, ReportSessionStateInput) (ReportSessionStateReply, error) {
	return ReportSessionStateReply{}, nil
}

func (c *captureSessionReporter) ReportSessionMessages(_ context.Context, input ReportSessionMessagesInput) (ReportSessionMessagesReply, error) {
	c.inputs = append(c.inputs, input)
	return ReportSessionMessagesReply{AcceptedCount: len(input.Updates)}, nil
}

func TestMessageStreamWriterWritesDeltasAndTerminalStatus(t *testing.T) {
	t.Parallel()

	reporter := &captureSessionReporter{}
	writer := NewMessageStreamWriter(
		reporter,
		"room-1",
		"agent-session-1",
		"message-1",
		EventSource{Provider: "codex"},
	)

	if err := writer.Write(context.Background(), "hel"); err != nil {
		t.Fatalf("Write(first): %v", err)
	}
	if err := writer.Write(context.Background(), "lo"); err != nil {
		t.Fatalf("Write(second): %v", err)
	}
	if err := writer.Close(context.Background(), "completed"); err != nil {
		t.Fatalf("Close: %v", err)
	}

	if len(reporter.inputs) != 3 {
		t.Fatalf("reported input count = %d, want 3", len(reporter.inputs))
	}
	if got := reporter.inputs[0].Updates[0].ContentDelta; got != "hel" {
		t.Fatalf("first delta = %q, want hel", got)
	}
	if got := reporter.inputs[1].Updates[0].ContentDelta; got != "lo" {
		t.Fatalf("second delta = %q, want lo", got)
	}
	if got := reporter.inputs[2].Updates[0].Status; got != "completed" {
		t.Fatalf("close status = %q, want completed", got)
	}
}
