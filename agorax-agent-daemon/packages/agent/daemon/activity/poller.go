package agentsessionstore

import "context"

type PollClient interface {
	ListAgents(ctx context.Context, workspaceID string) (*WorkspaceAgentSnapshot, error)
	ListSessionMessages(ctx context.Context, input ListSessionMessagesInput) (*ListSessionMessagesReply, error)
}

type PollerOptions struct {
	Limit int
}

type Poller struct {
	client PollClient
	limit  int
}

type SessionCursor struct {
	AfterVersion uint64
}

type PollResult struct {
	Snapshot *WorkspaceAgentSnapshot
	Messages map[string]ListSessionMessagesReply
	Cursors  map[string]SessionCursor
}

func NewPoller(client PollClient, options PollerOptions) *Poller {
	return &Poller{
		client: client,
		limit:  options.Limit,
	}
}

func (p *Poller) Poll(ctx context.Context, workspaceID string, cursors map[string]SessionCursor) (*PollResult, error) {
	snapshot, err := p.client.ListAgents(ctx, workspaceID)
	if err != nil {
		return nil, err
	}

	result := &PollResult{
		Snapshot: snapshot,
		Messages: map[string]ListSessionMessagesReply{},
		Cursors:  cloneCursors(cursors),
	}
	if snapshot == nil {
		return result, nil
	}

	for _, session := range snapshot.Sessions {
		cursor := result.Cursors[session.AgentSessionID]
		messages, err := p.client.ListSessionMessages(ctx, ListSessionMessagesInput{
			WorkspaceID:    workspaceID,
			AgentSessionID: session.AgentSessionID,
			AfterVersion:   cursor.AfterVersion,
			Limit:          p.limit,
			SessionOrigin:  session.SessionOrigin,
		})
		if err != nil {
			return nil, err
		}
		if messages == nil {
			continue
		}
		result.Messages[session.AgentSessionID] = *messages
		cursor.AfterVersion = maxMessageVersion(cursor.AfterVersion, *messages)
		result.Cursors[session.AgentSessionID] = cursor
	}
	return result, nil
}

func maxMessageVersion(current uint64, reply ListSessionMessagesReply) uint64 {
	if reply.LatestVersion > current {
		current = reply.LatestVersion
	}
	for _, message := range reply.Messages {
		if message.Version > current {
			current = message.Version
		}
	}
	return current
}

func cloneCursors(cursors map[string]SessionCursor) map[string]SessionCursor {
	out := make(map[string]SessionCursor, len(cursors))
	for sessionID, cursor := range cursors {
		out[sessionID] = cursor
	}
	return out
}
