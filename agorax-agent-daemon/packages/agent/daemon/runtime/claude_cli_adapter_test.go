package agentruntime

import (
	"context"
	"errors"
	"io"
	"os"
	"strings"
	"sync"
	"testing"

	activityshared "agorax.local/agent-daemon/packages/agent/daemon/activity/events"
)

// claudeFakeTransport records launch specs and serves a scripted connection.
type claudeFakeTransport struct {
	mu       sync.Mutex
	specs    []ProcessSpec
	startErr error
	conn     *claudeFakeConnection
}

func (t *claudeFakeTransport) Start(_ context.Context, spec ProcessSpec) (ProcessConnection, error) {
	t.mu.Lock()
	defer t.mu.Unlock()
	t.specs = append(t.specs, spec)
	if t.startErr != nil {
		return nil, t.startErr
	}
	return t.conn, nil
}

func (t *claudeFakeTransport) lastSpec() ProcessSpec {
	t.mu.Lock()
	defer t.mu.Unlock()
	if len(t.specs) == 0 {
		return ProcessSpec{}
	}
	return t.specs[len(t.specs)-1]
}

// claudeFakeConnection replays queued frames; when drained it returns EOF (or
// blocks on ctx for RecvContext) like a live process that has not exited yet.
type claudeFakeConnection struct {
	mu               sync.Mutex
	frames           []ProcessFrame
	sent             [][]byte
	killed           bool
	closed           bool
	closeInputCalled bool
	closeErr         error
	block            bool
	frameCh          chan ProcessFrame
}

func newClaudeFakeConnection(frames ...ProcessFrame) *claudeFakeConnection {
	return &claudeFakeConnection{frames: frames}
}

func (c *claudeFakeConnection) Send(data []byte) error {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.sent = append(c.sent, append([]byte(nil), data...))
	return nil
}

func (c *claudeFakeConnection) Recv() (ProcessFrame, error) {
	c.mu.Lock()
	if len(c.frames) > 0 {
		frame := c.frames[0]
		c.frames = c.frames[1:]
		c.mu.Unlock()
		return frame, nil
	}
	c.mu.Unlock()
	return ProcessFrame{}, io.EOF
}

func (c *claudeFakeConnection) RecvContext(ctx context.Context) (ProcessFrame, error) {
	c.mu.Lock()
	if len(c.frames) > 0 {
		frame := c.frames[0]
		c.frames = c.frames[1:]
		c.mu.Unlock()
		return frame, nil
	}
	c.mu.Unlock()
	if c.block {
		<-ctx.Done()
		return ProcessFrame{}, ctx.Err()
	}
	return ProcessFrame{}, io.EOF
}

func (c *claudeFakeConnection) Close() error {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.closed = true
	return c.closeErr
}

func (c *claudeFakeConnection) CloseInput() error {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.closeInputCalled = true
	return nil
}
func (*claudeFakeConnection) Terminate() error { return nil }

func (c *claudeFakeConnection) Kill() error {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.killed = true
	return nil
}

func (c *claudeFakeConnection) wasKilled() bool {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.killed
}

func (c *claudeFakeConnection) wasCloseInputCalled() bool {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.closeInputCalled
}

func claudeExitFrame(code int) ProcessFrame { return ProcessFrame{ExitCode: &code} }

func claudeStdoutFrames(chunks ...string) []ProcessFrame {
	frames := make([]ProcessFrame, 0, len(chunks)+1)
	for _, chunk := range chunks {
		frames = append(frames, ProcessFrame{Stdout: []byte(chunk)})
	}
	return append(frames, claudeExitFrame(0))
}

func newClaudeTestAdapter(transport ProcessTransport, resolver ProviderCommandResolver) *claudeCLIAdapter {
	return newClaudeCLIAdapter(
		claudeCLIAdapterConfig{
			provider:    ProviderClaudeCode,
			runtimeName: "claude-cli",
			command:     []string{"claude"},
			// Same PermissionModes/DefaultPermissionModeID the provider
			// descriptor declares for claude-code.
			permissionModeIDs: map[string]bool{
				"default":           true,
				"acceptEdits":       true,
				"dontAsk":           true,
				"bypassPermissions": true,
			},
			defaultPermissionModeID: "default",
		},
		transport,
		LegacyHostMetadata(),
		resolver,
	)
}

func claudeTestSession() Session {
	return standardTestSession(ProviderClaudeCode)
}

func TestClaudeCLIAdapterExecMapsStreamToTurnLifecycle(t *testing.T) {
	t.Parallel()

	conn := newClaudeFakeConnection(claudeStdoutFrames(
		`{"type":"system","subtype":"init","session_id":"sess-1","model":"claude-sonnet-4-5"}`+"\n",
		`{"type":"assistant","message":{"content":[{"type":"text","text":"OK"}]}}`+"\n",
		`{"type":"assistant","message":{"content":[{"type":"tool_use","id":"toolu_1","name":"Read","input":{"file_path":"/tmp/a.go"}}]}}`+"\n",
		`{"type":"user","message":{"content":[{"type":"tool_result","tool_use_id":"toolu_1","content":"package main"}]}}`+"\n",
		`{"type":"assistant","message":{"content":[{"type":"text","text":"Done."}]}}`+"\n",
		`{"type":"result","subtype":"success","result":"OK\n\nDone.","usage":{"input_tokens":10,"output_tokens":5},"duration_ms":900,"num_turns":2,"total_cost_usd":0.01}`+"\n",
	)...)
	transport := &claudeFakeTransport{conn: conn}
	adapter := newClaudeTestAdapter(transport, nil)
	session := claudeTestSession()

	var streamed []activityshared.Event
	events, err := adapter.Exec(context.Background(), session, []PromptContentBlock{
		{Type: "text", Text: "Reply with exactly: OK"},
	}, "", "turn-1", func(next []activityshared.Event) {
		streamed = append(streamed, next...)
	}, nil)
	if err != nil {
		t.Fatalf("Exec: %v", err)
	}
	if len(streamed) != len(events) {
		t.Fatalf("streamed %d events, Exec returned %d", len(streamed), len(events))
	}

	// Event type order: user prompt, turn start, provider turn start, activity,
	// provider turn completion as the terminal lifecycle event.
	var typeOrder []activityshared.EventType
	for _, event := range events {
		typeOrder = append(typeOrder, event.Type)
	}
	assertEventOrder(t, typeOrder,
		activityshared.EventMessageAppended,
		activityshared.EventTurnStarted,
		activityshared.EventRootProviderTurnStarted,
		activityshared.EventRootProviderTurnCompleted,
	)

	started := eventsOfType(events, activityshared.EventRootProviderTurnStarted)
	if len(started) != 1 || started[0].Payload.ProviderTurnID != "sess-1" {
		t.Fatalf("provider turn started = %#v, want session id sess-1", started)
	}
	completed := eventsOfType(events, activityshared.EventRootProviderTurnCompleted)
	if len(completed) != 1 ||
		completed[0].Payload.ProviderTurnID != "sess-1" ||
		completed[0].Payload.TurnOutcome != string(activityshared.TurnOutcomeCompleted) {
		t.Fatalf("provider turn completed = %#v, want completed with sess-1", completed)
	}
	if completed[0].Payload.Metadata["model"] != "claude-sonnet-4-5" {
		t.Fatalf("completed metadata = %#v, want model", completed[0].Payload.Metadata)
	}
	if usage, _ := completed[0].Payload.Metadata["usage"].(map[string]any); usage["input_tokens"] != float64(10) {
		t.Fatalf("completed usage = %#v", completed[0].Payload.Metadata["usage"])
	}
	if events[len(events)-1].Type != activityshared.EventRootProviderTurnCompleted {
		t.Fatalf("last event = %s, want root provider turn completed", events[len(events)-1].Type)
	}

	callsStarted := eventsOfType(events, activityshared.EventCallStarted)
	if len(callsStarted) != 1 || callsStarted[0].Payload.Name != "Read" {
		t.Fatalf("call started = %#v, want one Read", callsStarted)
	}
	callsCompleted := eventsOfType(events, activityshared.EventCallCompleted)
	if len(callsCompleted) != 1 || callsCompleted[0].Payload.Name != "Read" {
		t.Fatalf("call completed = %#v, want one Read", callsCompleted)
	}
	if output := callsCompleted[0].Payload.Output; output["stdout"] != "package main" {
		t.Fatalf("call output = %#v, want tool result text", output)
	}

	assistant := assistantMessageTexts(events)
	joined := strings.Join(assistant, "\n")
	if !strings.Contains(joined, "OK") || !strings.Contains(joined, "Done.") {
		t.Fatalf("assistant messages = %#v, want streamed reply text", assistant)
	}
}

func TestClaudeCLIAdapterResultErrorFailsTurnWithVisibleMessage(t *testing.T) {
	t.Parallel()

	conn := newClaudeFakeConnection(claudeStdoutFrames(
		`{"type":"system","subtype":"init","session_id":"sess-2"}`+"\n",
		`{"type":"result","subtype":"error","is_error":true,"result":"authentication failed"}`+"\n",
	)...)
	transport := &claudeFakeTransport{conn: conn}
	adapter := newClaudeTestAdapter(transport, nil)

	events, err := adapter.Exec(context.Background(), claudeTestSession(), []PromptContentBlock{
		{Type: "text", Text: "hi"},
	}, "", "turn-err", nil, nil)
	if err != nil {
		t.Fatalf("Exec: %v", err)
	}
	completed := eventsOfType(events, activityshared.EventRootProviderTurnCompleted)
	if len(completed) != 1 ||
		completed[0].Payload.TurnOutcome != string(activityshared.TurnOutcomeFailed) ||
		completed[0].Payload.ProviderTurnID != "sess-2" {
		t.Fatalf("provider turn completed = %#v, want failed with sess-2", completed)
	}
	if completed[0].Payload.Metadata["error"] != "authentication failed" {
		t.Fatalf("completed metadata = %#v, want visible error", completed[0].Payload.Metadata)
	}
	failed := assistantMessageWithStatus(events, messageStreamStateFailed)
	if !strings.Contains(failed, "authentication failed") {
		t.Fatalf("failed assistant message = %q, want error text visible", failed)
	}
}

func TestClaudeCLIAdapterSpawnFailureSettlesFailedTurn(t *testing.T) {
	t.Parallel()

	transport := &claudeFakeTransport{startErr: errors.New("exec: \"claude\": executable file not found in $PATH")}
	adapter := newClaudeTestAdapter(transport, nil)

	events, err := adapter.Exec(context.Background(), claudeTestSession(), []PromptContentBlock{
		{Type: "text", Text: "hi"},
	}, "", "turn-spawn", nil, nil)
	if err != nil {
		t.Fatalf("Exec: %v", err)
	}
	started := eventsOfType(events, activityshared.EventRootProviderTurnStarted)
	if len(started) != 1 || started[0].Payload.ProviderTurnID != "turn-spawn" {
		t.Fatalf("provider turn started = %#v, want turn id fallback", started)
	}
	completed := eventsOfType(events, activityshared.EventRootProviderTurnCompleted)
	if len(completed) != 1 ||
		completed[0].Payload.TurnOutcome != string(activityshared.TurnOutcomeFailed) ||
		completed[0].Payload.ProviderTurnID != "turn-spawn" {
		t.Fatalf("provider turn completed = %#v, want failed with turn id fallback", completed)
	}
	if completed[0].Payload.Metadata["error"] == "" {
		t.Fatalf("completed metadata = %#v, want spawn error", completed[0].Payload.Metadata)
	}
	if calls := eventsOfType(events, activityshared.EventCallStarted); len(calls) != 0 {
		t.Fatalf("call events = %#v, want none for a failed spawn", calls)
	}
}

func TestClaudeCLIAdapterMissingInitFallsBackToTurnID(t *testing.T) {
	t.Parallel()

	conn := newClaudeFakeConnection(claudeStdoutFrames(
		`{"type":"assistant","message":{"content":[{"type":"text","text":"OK"}]}}`+"\n",
		`{"type":"result","subtype":"success","result":"OK"}`+"\n",
	)...)
	transport := &claudeFakeTransport{conn: conn}
	adapter := newClaudeTestAdapter(transport, nil)

	events, err := adapter.Exec(context.Background(), claudeTestSession(), []PromptContentBlock{
		{Type: "text", Text: "hi"},
	}, "", "turn-noinit", nil, nil)
	if err != nil {
		t.Fatalf("Exec: %v", err)
	}
	started := eventsOfType(events, activityshared.EventRootProviderTurnStarted)
	if len(started) != 1 || started[0].Payload.ProviderTurnID != "turn-noinit" {
		t.Fatalf("provider turn started = %#v, want turn id fallback", started)
	}
	completed := eventsOfType(events, activityshared.EventRootProviderTurnCompleted)
	if len(completed) != 1 ||
		completed[0].Payload.ProviderTurnID != "turn-noinit" ||
		completed[0].Payload.TurnOutcome != string(activityshared.TurnOutcomeCompleted) {
		t.Fatalf("provider turn completed = %#v, want completed turn id fallback", completed)
	}
}

func TestClaudeCLIAdapterAPIRetry429FailsFastAndKillsProcess(t *testing.T) {
	t.Parallel()

	// After the 429 frame the connection would otherwise block forever (Claude
	// Code's internal retry loop). Fail-fast must kill and settle as failed.
	conn := newClaudeFakeConnection(claudeStdoutFrames(
		`{"type":"system","subtype":"init","session_id":"sess-429","model":"DeepSeek-V4-Flash"}`+"\n",
		`{"type":"system","subtype":"api_retry","attempt":1,"max_retries":10,"retry_delay_ms":564,"error_status":429,"error":"rate_limit","session_id":"sess-429"}`+"\n",
	)...)
	transport := &claudeFakeTransport{conn: conn}
	adapter := newClaudeTestAdapter(transport, nil)

	events, err := adapter.Exec(context.Background(), claudeTestSession(), []PromptContentBlock{
		{Type: "text", Text: "hi"},
	}, "", "turn-429", nil, nil)
	if err != nil {
		t.Fatalf("Exec: %v", err)
	}
	if !conn.wasKilled() {
		t.Fatal("expected Claude CLI process to be killed on 429 api_retry")
	}
	completed := eventsOfType(events, activityshared.EventRootProviderTurnCompleted)
	if len(completed) != 1 || completed[0].Payload.TurnOutcome != string(activityshared.TurnOutcomeFailed) {
		t.Fatalf("provider turn completed = %#v, want failed", completed)
	}
	message, _ := completed[0].Payload.Metadata["error"].(string)
	if !strings.Contains(message, "429") || !strings.Contains(message, "rate_limit") {
		t.Fatalf("error metadata = %q, want 429 rate_limit", message)
	}
}

func TestClaudeCLIAdapterNonZeroExitWithoutResultFailsTurn(t *testing.T) {
	t.Parallel()

	conn := newClaudeFakeConnection(
		ProcessFrame{Stderr: []byte("panic: something broke")},
		claudeExitFrame(1),
	)
	transport := &claudeFakeTransport{conn: conn}
	adapter := newClaudeTestAdapter(transport, nil)

	events, err := adapter.Exec(context.Background(), claudeTestSession(), []PromptContentBlock{
		{Type: "text", Text: "hi"},
	}, "", "turn-exit", nil, nil)
	if err != nil {
		t.Fatalf("Exec: %v", err)
	}
	completed := eventsOfType(events, activityshared.EventRootProviderTurnCompleted)
	if len(completed) != 1 || completed[0].Payload.TurnOutcome != string(activityshared.TurnOutcomeFailed) {
		t.Fatalf("provider turn completed = %#v, want failed", completed)
	}
	message, _ := completed[0].Payload.Metadata["error"].(string)
	if !strings.Contains(message, "exited with code 1") || !strings.Contains(message, "panic") {
		t.Fatalf("error metadata = %#v, want exit code and stderr tail", completed[0].Payload.Metadata)
	}
}

func TestClaudeCLIAdapterCancelKillsProcessAndSettlesCanceled(t *testing.T) {
	t.Parallel()

	conn := newClaudeFakeConnection()
	conn.block = true
	transport := &claudeFakeTransport{conn: conn}
	adapter := newClaudeTestAdapter(transport, nil)
	session := claudeTestSession()

	ctx, cancel := context.WithCancel(context.Background())
	execDone := make(chan []activityshared.Event, 1)
	go func() {
		events, _ := adapter.Exec(ctx, session, []PromptContentBlock{{Type: "text", Text: "hi"}}, "", "turn-cancel", nil, nil)
		execDone <- events
	}()

	waitForCondition(t, func() bool {
		adapter.mu.Lock()
		defer adapter.mu.Unlock()
		return adapter.active[session.AgentSessionID] != nil
	})
	if _, err := adapter.Cancel(context.Background(), session, "user_requested"); err != nil {
		t.Fatalf("Cancel: %v", err)
	}
	if !conn.wasKilled() {
		t.Fatal("Cancel did not kill the managed process")
	}
	cancel()
	events := <-execDone

	completed := eventsOfType(events, activityshared.EventRootProviderTurnCompleted)
	if len(completed) != 1 ||
		completed[0].Payload.TurnOutcome != string(activityshared.TurnOutcomeCanceled) ||
		completed[0].Payload.ProviderTurnID != "turn-cancel" {
		t.Fatalf("provider turn completed = %#v, want canceled with turn id fallback", completed)
	}
}

func TestClaudeCLIAdapterCommandResolverFailureFailsTurn(t *testing.T) {
	t.Parallel()

	resolver := func(context.Context, string) (ProviderCommand, error) {
		return ProviderCommand{}, errors.New("claude runtime unavailable")
	}
	transport := &claudeFakeTransport{conn: newClaudeFakeConnection()}
	adapter := newClaudeTestAdapter(transport, resolver)

	events, err := adapter.Exec(context.Background(), claudeTestSession(), []PromptContentBlock{
		{Type: "text", Text: "hi"},
	}, "", "turn-resolve", nil, nil)
	if err != nil {
		t.Fatalf("Exec: %v", err)
	}
	if len(transport.specs) != 0 {
		t.Fatalf("transport specs = %#v, want no launch after resolver failure", transport.specs)
	}
	completed := eventsOfType(events, activityshared.EventRootProviderTurnCompleted)
	if len(completed) != 1 || completed[0].Payload.TurnOutcome != string(activityshared.TurnOutcomeFailed) {
		t.Fatalf("provider turn completed = %#v, want failed", completed)
	}
	if completed[0].Payload.Metadata["error"] != "claude runtime unavailable" {
		t.Fatalf("completed metadata = %#v, want resolver error", completed[0].Payload.Metadata)
	}
}

func TestClaudeCLIAdapterUsesResolvedCommandAndEnvWithoutResuffixing(t *testing.T) {
	t.Parallel()

	// A Windows-shaped npm launcher name must flow through the resolver and
	// argv untouched: the adapter never appends or assumes an extension.
	resolver := func(_ context.Context, provider string) (ProviderCommand, error) {
		if provider != ProviderClaudeCode {
			return ProviderCommand{}, errors.New("unexpected provider " + provider)
		}
		return ProviderCommand{
			Command: []string{"claude.cmd"},
			Env:     []string{"CLAUDE_RESOLVED=1"},
		}, nil
	}
	conn := newClaudeFakeConnection(claudeStdoutFrames(
		`{"type":"system","subtype":"init","session_id":"sess-3"}`+"\n",
		`{"type":"result","subtype":"success","result":"OK"}`+"\n",
	)...)
	transport := &claudeFakeTransport{conn: conn}
	adapter := newClaudeTestAdapter(transport, resolver)
	session := claudeTestSession()
	session.Env = []string{"CLAUDE_SESSION_ENV=1"}

	events, err := adapter.Exec(context.Background(), session, []PromptContentBlock{
		{Type: "text", Text: "hi"},
	}, "", "turn-resolve-ok", nil, nil)
	if err != nil {
		t.Fatalf("Exec: %v", err)
	}
	if completed := eventsOfType(events, activityshared.EventRootProviderTurnCompleted); len(completed) != 1 ||
		completed[0].Payload.TurnOutcome != string(activityshared.TurnOutcomeCompleted) {
		t.Fatalf("events = %#v, want completed turn", events)
	}
	spec := transport.lastSpec()
	if len(spec.Command) == 0 || spec.Command[0] != "claude.cmd" {
		t.Fatalf("launch command = %#v, want resolved claude.cmd", spec.Command)
	}
	if !envListContains(spec.Env, "CLAUDE_RESOLVED=1") || !envListContains(spec.Env, "CLAUDE_SESSION_ENV=1") {
		t.Fatalf("launch env = %#v, want resolver and session env", spec.Env)
	}
	if spec.CWD != session.CWD {
		t.Fatalf("launch cwd = %q, want session cwd %q", spec.CWD, session.CWD)
	}
}

func TestClaudeCLIAdapterArgvContract(t *testing.T) {
	t.Parallel()

	conn := newClaudeFakeConnection(claudeStdoutFrames(
		`{"type":"system","subtype":"init","session_id":"sess-4"}`+"\n",
		`{"type":"result","subtype":"success","result":"OK"}`+"\n",
	)...)
	transport := &claudeFakeTransport{conn: conn}
	adapter := newClaudeTestAdapter(transport, nil)
	session := claudeTestSession()
	session.Settings = &SessionSettings{Model: "claude-opus-4-1", ReasoningEffort: "high"}

	if _, err := adapter.Exec(context.Background(), session, []PromptContentBlock{
		{Type: "text", Text: "say OK"},
	}, "", "turn-argv", nil, nil); err != nil {
		t.Fatalf("Exec: %v", err)
	}
	argv := transport.lastSpec().Command
	if len(argv) == 0 {
		t.Fatal("launch argv is empty")
	}
	// The launch must be a pure argv array: one executable plus arguments, no
	// shell wrapper anywhere (POSIX sh -c nor Windows cmd /c).
	for _, wrapper := range [][2]string{{"sh", "-c"}, {"cmd", "/c"}, {"cmd.exe", "/c"}, {"powershell", "-Command"}} {
		if len(argv) >= 2 && argv[0] == wrapper[0] && strings.EqualFold(argv[1], wrapper[1]) {
			t.Fatalf("argv %v wraps a shell %v %v", argv, wrapper[0], wrapper[1])
		}
	}
	assertArgvContainsInOrder(t, argv,
		"claude",
		"--dangerously-skip-permissions",
		"-p",
		"--output-format", "stream-json",
		"--verbose",
		"--include-partial-messages",
		"--model", "claude-opus-4-1",
		"--effort", "high",
		"--", "say OK",
	)
	// The prompt is exactly one argv element: no quoting or escaping is
	// spliced into the array by the adapter.
	if argv[len(argv)-2] != "--" || argv[len(argv)-1] != "say OK" {
		t.Fatalf("argv tail = %v, want `-- <prompt>`", argv[len(argv)-2:])
	}
	if strings.Contains(argv[len(argv)-1], "\"") || strings.Contains(argv[len(argv)-1], "'") {
		t.Fatalf("prompt argv element carries quote characters: %q", argv[len(argv)-1])
	}
}

func TestClaudePermissionArgvDeclaredArgsWinVerbatim(t *testing.T) {
	t.Parallel()

	declared := []string{"--dangerously-skip-permissions", "--strict-mcp-config"}
	if got := claudePermissionArgv("acceptEdits", declared); !stringSlicesEqual(got, declared) {
		t.Fatalf("declared skip flag = %v, want declaration returned as-is", got)
	}

	declaredMode := []string{"--permission-mode", "plan", "--verbose"}
	if got := claudePermissionArgv("bypassPermissions", declaredMode); !stringSlicesEqual(got, declaredMode) {
		t.Fatalf("declared permission-mode = %v, want declaration returned as-is", got)
	}

	declaredModeEq := []string{"--permission-mode=acceptEdits"}
	if got := claudePermissionArgv("", declaredModeEq); !stringSlicesEqual(got, declaredModeEq) {
		t.Fatalf("declared --permission-mode= form = %v, want declaration returned as-is", got)
	}
}

func TestClaudePermissionArgvExplicitModesMapToCLIArgs(t *testing.T) {
	t.Parallel()

	if got := claudePermissionArgv("bypassPermissions", nil); !stringSlicesEqual(got, []string{"--dangerously-skip-permissions"}) {
		t.Fatalf("bypassPermissions = %v, want skip flag", got)
	}
	if got := claudePermissionArgv("acceptEdits", nil); !stringSlicesEqual(got, []string{"--permission-mode", "acceptEdits"}) {
		t.Fatalf("acceptEdits = %v, want permission-mode pair", got)
	}
}

func TestClaudePermissionArgvNoConclusionReturnsNil(t *testing.T) {
	t.Parallel()

	// "default" is the descriptor default and means interactive asks: print
	// mode cannot answer them, so the pure function defers to the caller.
	for _, modeID := range []string{"default", "dontAsk", "unknown-mode", "", "  "} {
		if got := claudePermissionArgv(modeID, nil); got != nil {
			t.Fatalf("mode %q = %v, want nil so the caller decides", modeID, got)
		}
	}
}

func TestClaudeCLIAdapterPermissionFallbackDecisionTable(t *testing.T) {
	t.Parallel()

	cases := []struct {
		name    string
		session Session
		// mutate customizes the adapter config after construction.
		mutate func(*claudeCLIAdapter)
		want   []string
	}{
		{
			name:    "empty session mode with descriptor default default falls back to explicit bypass",
			session: Session{},
			want:    []string{"--dangerously-skip-permissions"},
		},
		{
			name:    "session default mode defers to descriptor default then falls back",
			session: Session{PermissionModeID: "default"},
			want:    []string{"--dangerously-skip-permissions"},
		},
		{
			name:    "valid but unmappable dontAsk mode falls back to bypass",
			session: Session{PermissionModeID: "dontAsk"},
			want:    []string{"--dangerously-skip-permissions"},
		},
		{
			name:    "unknown session mode fails closed to fallback",
			session: Session{PermissionModeID: "not-a-real-mode"},
			want:    []string{"--dangerously-skip-permissions"},
		},
		{
			name:    "session acceptEdits maps to permission mode",
			session: Session{PermissionModeID: "acceptEdits"},
			want:    []string{"--permission-mode", "acceptEdits"},
		},
		{
			name:    "session bypassPermissions maps to skip flag",
			session: Session{PermissionModeID: "bypassPermissions"},
			want:    []string{"--dangerously-skip-permissions"},
		},
		{
			name:    "descriptor default acceptEdits applies when session is silent",
			session: Session{},
			mutate: func(a *claudeCLIAdapter) {
				a.config.defaultPermissionModeID = "acceptEdits"
			},
			want: []string{"--permission-mode", "acceptEdits"},
		},
		{
			name:    "descriptor default bypassPermissions applies when session is silent",
			session: Session{},
			mutate: func(a *claudeCLIAdapter) {
				a.config.defaultPermissionModeID = "bypassPermissions"
			},
			want: []string{"--dangerously-skip-permissions"},
		},
	}
	for _, testCase := range cases {
		t.Run(testCase.name, func(t *testing.T) {
			t.Parallel()
			adapter := newClaudeTestAdapter(&claudeFakeTransport{conn: newClaudeFakeConnection()}, nil)
			if testCase.mutate != nil {
				testCase.mutate(adapter)
			}
			if got := adapter.permissionArgv(testCase.session); !stringSlicesEqual(got, testCase.want) {
				t.Fatalf("permissionArgv = %v, want %v", got, testCase.want)
			}
		})
	}
}

func TestClaudeCLIAdapterDeclaredArgsReachArgvVerbatim(t *testing.T) {
	t.Parallel()

	// Declaration-owned args that declare the permission policy win verbatim
	// and the adapter must not inject a second policy flag.
	conn := newClaudeFakeConnection(claudeStdoutFrames(
		`{"type":"system","subtype":"init","session_id":"sess-5"}`+"\n",
		`{"type":"result","subtype":"success","result":"OK"}`+"\n",
	)...)
	transport := &claudeFakeTransport{conn: conn}
	adapter := newClaudeTestAdapter(transport, nil)
	adapter.config.command = []string{"claude", "--permission-mode", "plan", "--append-system-prompt", "ctx"}
	session := claudeTestSession()
	session.PermissionModeID = "bypassPermissions"

	if _, err := adapter.Exec(context.Background(), session, []PromptContentBlock{
		{Type: "text", Text: "hi"},
	}, "", "turn-decl", nil, nil); err != nil {
		t.Fatalf("Exec: %v", err)
	}
	argv := transport.lastSpec().Command
	assertArgvContainsInOrder(t, argv,
		"claude", "--permission-mode", "plan", "--append-system-prompt", "ctx", "-p")
	if strings.Count(strings.Join(argv, "\x00"), "--dangerously-skip-permissions") != 0 {
		t.Fatalf("argv %v injects a bypass flag over the declared policy", argv)
	}

	// Non-policy declared args are spliced after the decided policy segment.
	conn2 := newClaudeFakeConnection(claudeStdoutFrames(
		`{"type":"system","subtype":"init","session_id":"sess-6"}`+"\n",
		`{"type":"result","subtype":"success","result":"OK"}`+"\n",
	)...)
	transport2 := &claudeFakeTransport{conn: conn2}
	adapter2 := newClaudeTestAdapter(transport2, nil)
	adapter2.config.command = []string{"claude", "--append-system-prompt", "ctx"}
	if _, err := adapter2.Exec(context.Background(), claudeTestSession(), []PromptContentBlock{
		{Type: "text", Text: "hi"},
	}, "", "turn-decl2", nil, nil); err != nil {
		t.Fatalf("Exec: %v", err)
	}
	argv2 := transport2.lastSpec().Command
	assertArgvContainsInOrder(t, argv2,
		"claude", "--dangerously-skip-permissions", "--append-system-prompt", "ctx", "-p")
}

func TestClaudeCLIAdapterCleanupLiveSessionResourcesKillsInFlightTurn(t *testing.T) {
	t.Parallel()

	// The periodic live-session reaper calls CleanupLiveSessionResources on
	// every sweep; an in-flight turn must never be killed by it. Only handles
	// whose Exec finished but whose close failed (detached) are reaped.
	conn := newClaudeFakeConnection()
	conn.block = true
	transport := &claudeFakeTransport{conn: conn}
	adapter := newClaudeTestAdapter(transport, nil)
	session := claudeTestSession()

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	execDone := make(chan struct{})
	go func() {
		defer close(execDone)
		_, _ = adapter.Exec(ctx, session, []PromptContentBlock{{Type: "text", Text: "hi"}}, "", "turn-clean", nil, nil)
	}()
	waitForCondition(t, func() bool {
		adapter.mu.Lock()
		defer adapter.mu.Unlock()
		return adapter.active[session.AgentSessionID] != nil
	})

	result := adapter.CleanupLiveSessionResources(context.Background(), 4)
	if result.Attempted != 0 || result.Cleaned != 0 || result.Failed != 0 {
		t.Fatalf("cleanup result = %#v, want no-op while the turn is in flight", result)
	}
	if conn.wasKilled() {
		t.Fatal("cleanup killed an in-flight process")
	}
	cancel()
	<-execDone
}

func TestClaudeCLIAdapterCleanupLiveSessionResourcesReapsFailedClose(t *testing.T) {
	t.Parallel()

	// A turn whose process close fails after Exec settles leaves a detached
	// physical handle; the reaper kills exactly that handle.
	conn := newClaudeFakeConnection(claudeStdoutFrames(
		`{"type":"system","subtype":"init","session_id":"sess-det"}`+"\n",
		`{"type":"result","subtype":"success","result":"OK"}`+"\n",
	)...)
	conn.closeErr = errors.New("close: transport stuck")
	transport := &claudeFakeTransport{conn: conn}
	adapter := newClaudeTestAdapter(transport, nil)

	events, err := adapter.Exec(context.Background(), claudeTestSession(), []PromptContentBlock{
		{Type: "text", Text: "hi"},
	}, "", "turn-detached", nil, nil)
	if err != nil {
		t.Fatalf("Exec: %v", err)
	}
	if completed := eventsOfType(events, activityshared.EventRootProviderTurnCompleted); len(completed) != 1 ||
		completed[0].Payload.TurnOutcome != string(activityshared.TurnOutcomeCompleted) {
		t.Fatalf("events = %#v, want completed turn", events)
	}

	adapter.mu.Lock()
	detachedCount := len(adapter.detached)
	adapter.mu.Unlock()
	if detachedCount != 1 {
		t.Fatalf("detached handles = %d, want 1 after the failed close", detachedCount)
	}

	result := adapter.CleanupLiveSessionResources(context.Background(), 4)
	if result.Attempted != 1 || result.Cleaned != 1 || result.Failed != 0 {
		t.Fatalf("cleanup result = %#v, want one attempted and cleaned", result)
	}
	if !conn.wasKilled() {
		t.Fatal("cleanup did not kill the detached process")
	}
}

func TestClaudeCLIAdapterExecClosesStdinAfterSpawn(t *testing.T) {
	t.Parallel()

	// Print mode takes the prompt from argv and never reads stdin; the
	// adapter must close it right after spawn (TS `stdio: 'ignore'` parity).
	conn := newClaudeFakeConnection(claudeStdoutFrames(
		`{"type":"system","subtype":"init","session_id":"sess-stdin"}`+"\n",
		`{"type":"result","subtype":"success","result":"OK"}`+"\n",
	)...)
	transport := &claudeFakeTransport{conn: conn}
	adapter := newClaudeTestAdapter(transport, nil)

	if _, err := adapter.Exec(context.Background(), claudeTestSession(), []PromptContentBlock{
		{Type: "text", Text: "hi"},
	}, "", "turn-stdin", nil, nil); err != nil {
		t.Fatalf("Exec: %v", err)
	}
	if !conn.wasCloseInputCalled() {
		t.Fatal("Exec did not close the process stdin after spawn")
	}
	if len(conn.sent) != 0 {
		t.Fatalf("stdin writes = %d, want none (prompt travels via argv)", len(conn.sent))
	}
}

func TestClaudeAuthMirrorEnv(t *testing.T) {
	t.Parallel()

	if os.Getenv("ANTHROPIC_AUTH_TOKEN") != "" || os.Getenv("ANTHROPIC_API_KEY") != "" {
		t.Skip("ANTHROPIC_* present in the process environment")
	}
	if mirrored := claudeAuthMirrorEnv(nil); mirrored != nil {
		t.Fatalf("mirror without token = %v, want nil", mirrored)
	}
	mirrored := claudeAuthMirrorEnv([]string{"ANTHROPIC_AUTH_TOKEN=tok-1"})
	if len(mirrored) != 1 || mirrored[0] != "ANTHROPIC_API_KEY=tok-1" {
		t.Fatalf("mirror with token only = %v, want API_KEY mirror", mirrored)
	}
	if mirrored := claudeAuthMirrorEnv([]string{
		"ANTHROPIC_AUTH_TOKEN=tok-1",
		"ANTHROPIC_API_KEY=already",
	}); mirrored != nil {
		t.Fatalf("mirror with existing key = %v, want nil", mirrored)
	}
}

func TestClaudeCLIAdapterStartResumeCloseAreNeutral(t *testing.T) {
	t.Parallel()

	adapter := newClaudeTestAdapter(&claudeFakeTransport{conn: newClaudeFakeConnection()}, nil)
	session := claudeTestSession()
	if adapter.Provider() != ProviderClaudeCode {
		t.Fatalf("Provider() = %q, want %q", adapter.Provider(), ProviderClaudeCode)
	}
	events, err := adapter.Start(context.Background(), session)
	if err != nil || len(events) != 1 || events[0].Type != activityshared.EventType(EventSessionStarted) {
		t.Fatalf("Start = (%v, %#v), want one session.started", err, events)
	}
	if err := adapter.Resume(context.Background(), session); err != nil {
		t.Fatalf("Resume: %v", err)
	}
	if err := adapter.Close(context.Background(), session); err != nil {
		t.Fatalf("Close: %v", err)
	}
	if _, err := adapter.Cancel(context.Background(), session, "none"); !errors.Is(err, ErrSessionNoActiveTurn) {
		t.Fatalf("Cancel without active turn = %v, want ErrSessionNoActiveTurn", err)
	}
}

func assertEventOrder(t *testing.T, order []activityshared.EventType, want ...activityshared.EventType) {
	t.Helper()
	cursor := 0
	for _, eventType := range order {
		if cursor < len(want) && eventType == want[cursor] {
			cursor++
		}
	}
	if cursor != len(want) {
		t.Fatalf("event order %v does not contain %v in order", order, want)
	}
}

func assertArgvContainsInOrder(t *testing.T, argv []string, want ...string) {
	t.Helper()
	joined := strings.Join(argv, "\x00")
	expected := strings.Join(want, "\x00")
	if !strings.Contains(joined, expected) {
		t.Fatalf("argv %v does not contain %v in order", argv, want)
	}
}

func assistantMessageTexts(events []activityshared.Event) []string {
	var texts []string
	for _, event := range events {
		if event.Type != activityshared.EventMessageAppended || event.Payload.Role != activityshared.MessageRoleAssistant {
			continue
		}
		texts = append(texts, event.Payload.Content)
	}
	return texts
}

func assistantMessageWithStatus(events []activityshared.Event, status string) string {
	for _, event := range events {
		if event.Type == activityshared.EventMessageAppended &&
			event.Payload.Role == activityshared.MessageRoleAssistant &&
			event.Payload.Metadata["streamState"] == status {
			return event.Payload.Content
		}
	}
	return ""
}

func envListContains(env []string, want string) bool {
	for _, item := range env {
		if item == want {
			return true
		}
	}
	return false
}

func stringSlicesEqual(a, b []string) bool {
	if len(a) != len(b) {
		return false
	}
	for i := range a {
		if a[i] != b[i] {
			return false
		}
	}
	return true
}
