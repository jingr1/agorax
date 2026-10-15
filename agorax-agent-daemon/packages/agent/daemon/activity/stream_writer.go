package agentsessionstore

import "context"

type MessageStreamWriter struct {
	reporter       SessionActivityReporter
	workspaceID    string
	agentSessionID string
	messageID      string
	source         EventSource
}

func NewMessageStreamWriter(
	reporter SessionActivityReporter,
	workspaceID, agentSessionID, messageID string,
	source EventSource,
) *MessageStreamWriter {
	return &MessageStreamWriter{
		reporter:       reporter,
		workspaceID:    workspaceID,
		agentSessionID: agentSessionID,
		messageID:      messageID,
		source:         source,
	}
}

func (w *MessageStreamWriter) Write(ctx context.Context, chunk string) error {
	if w == nil || w.reporter == nil {
		return nil
	}
	_, err := w.reporter.ReportSessionMessages(ctx, ReportSessionMessagesInput{
		WorkspaceID:    w.workspaceID,
		AgentSessionID: w.agentSessionID,
		Source:         w.source,
		Updates: []WorkspaceAgentSessionMessageUpdate{{
			MessageID:    w.messageID,
			ContentDelta: chunk,
		}},
	})
	return err
}

func (w *MessageStreamWriter) Close(ctx context.Context, status string) error {
	if w == nil || w.reporter == nil {
		return nil
	}
	_, err := w.reporter.ReportSessionMessages(ctx, ReportSessionMessagesInput{
		WorkspaceID:    w.workspaceID,
		AgentSessionID: w.agentSessionID,
		Source:         w.source,
		Updates: []WorkspaceAgentSessionMessageUpdate{{
			MessageID: w.messageID,
			Status:    status,
		}},
	})
	return err
}
