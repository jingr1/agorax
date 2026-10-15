package agentruntime

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strings"
	"sync"

	activityshared "agorax.local/agent-daemon/packages/agent/daemon/activity/events"
)

// claudeCLIAdapter hosts Claude Code through its print-mode CLI
// (`claude -p --output-format stream-json`), one managed process per Turn.
// The adapter keeps the provider-neutral lifecycle only: there is no embedded
// SDK and no interactive permission bridge, so permission prompts are decided
// at argv build time exactly like the TypeScript CLI adapter.
type claudeCLIAdapter struct {
	config          claudeCLIAdapterConfig
	transport       ProcessTransport
	host            HostMetadata
	commandResolver ProviderCommandResolver
	preparer        ProviderLaunchPreparer

	mu     sync.Mutex
	active map[string]*claudeCLIActiveTurn
	// detached owns process handles whose Exec already finished but whose
	// close failed, so the physical process can outlive the canonical turn.
	// The periodic live-session reaper reaps only these — never an
	// in-flight turn, which the controller settles through cancel.
	detached map[ProcessConnection]struct{}
}

type claudeCLIAdapterConfig struct {
	provider    string
	runtimeName string
	command     []string
	// permissionModeIDs is the descriptor PermissionModes id set; a session
	// permissionModeId outside this set is treated as unset (fail closed
	// toward the documented fallback, never toward a guessed CLI mode).
	permissionModeIDs map[string]bool
	// defaultPermissionModeID is the descriptor DefaultPermissionModeID,
	// consulted when the session setting yields no CLI-safe conclusion.
	defaultPermissionModeID string
}

// declaredArgs is the declaration-owned command tail (agents.yaml `args`
// equivalent). The executable is command[0]; everything after it flows into
// argv verbatim unless the permission policy function already returned it.
func (c claudeCLIAdapterConfig) declaredArgs() []string {
	if len(c.command) <= 1 {
		return nil
	}
	return append([]string(nil), c.command[1:]...)
}

const claudeSkipPermissionsFlag = "--dangerously-skip-permissions"

// claudeArgsDeclarePermissionPolicy reports whether declaration-owned args
// already choose a Claude Code permission policy themselves.
func claudeArgsDeclarePermissionPolicy(declArgs []string) bool {
	for _, arg := range declArgs {
		if arg == claudeSkipPermissionsFlag || arg == "--permission-mode" ||
			strings.HasPrefix(arg, "--permission-mode=") {
			return true
		}
	}
	return false
}

// claudePermissionArgv is the pure, config-driven permission-policy decision
// for a managed `claude -p` launch. Resolution order:
//  1. declArgs already declare `--permission-mode` / `--dangerously-skip-permissions`
//     → they are returned unchanged (declaration wins, like the TS adapter's
//     withManagedPermissionBypass).
//  2. modeId (already validated against the descriptor PermissionModes by the
//     caller): "bypassPermissions" → the skip flag; "acceptEdits" →
//     `--permission-mode acceptEdits`.
//  3. "default", any other descriptor mode without a CLI equivalent, unknown
//     or empty modeId → nil, so the caller can consult the descriptor
//     DefaultPermissionModeID and then apply its single documented fallback.
//
// There is deliberately no bypass here: the fallback lives in one place at
// the call site, with its reason written down next to it.
func claudePermissionArgv(modeId string, declArgs []string) []string {
	if claudeArgsDeclarePermissionPolicy(declArgs) {
		return append([]string(nil), declArgs...)
	}
	switch strings.TrimSpace(modeId) {
	case "bypassPermissions":
		return []string{claudeSkipPermissionsFlag}
	case "acceptEdits":
		return []string{"--permission-mode", "acceptEdits"}
	default:
		return nil
	}
}

type claudeCLIActiveTurn struct {
	agentSessionID string
	turnID         string
	conn           ProcessConnection
}

func newClaudeCLIAdapter(
	config claudeCLIAdapterConfig,
	transport ProcessTransport,
	host HostMetadata,
	commandResolver ProviderCommandResolver,
) *claudeCLIAdapter {
	if len(config.command) == 0 || strings.TrimSpace(config.command[0]) == "" {
		config.command = []string{"claude"}
	}
	return &claudeCLIAdapter{
		config:          config,
		transport:       transport,
		host:            host,
		commandResolver: commandResolver,
		active:          make(map[string]*claudeCLIActiveTurn),
		detached:        make(map[ProcessConnection]struct{}),
	}
}

func (a *claudeCLIAdapter) Provider() string {
	return a.config.provider
}

// SetProviderLaunchPreparer lets a host composition root wrap launches (skill
// materialization, executable pinning) without this adapter importing it.
func (a *claudeCLIAdapter) SetProviderLaunchPreparer(preparer ProviderLaunchPreparer) {
	if a == nil {
		return
	}
	a.mu.Lock()
	defer a.mu.Unlock()
	a.preparer = preparer
}

// Start records the runtime session. Claude Code print mode has no
// long-lived provider process to spawn: each Exec launches its own CLI
// process, so there is nothing to connect here.
func (a *claudeCLIAdapter) Start(_ context.Context, session Session) ([]activityshared.Event, error) {
	return []activityshared.Event{newSessionActivityEvent(session, EventSessionStarted, SessionStatusReady, map[string]any{
		"adapter": a.config.runtimeName,
		"command": strings.Join(a.config.command, " "),
	})}, nil
}

// Resume reconnects nothing: a per-Turn CLI process never outlives its Exec.
func (*claudeCLIAdapter) Resume(context.Context, Session) error { return nil }

// Close releases nothing: the adapter holds no provider process between turns.
func (*claudeCLIAdapter) Close(context.Context, Session) error { return nil }

// Cancel kills the in-flight CLI process group. The interrupted Exec settles
// the canonical turn as canceled through the ordinary event path.
func (a *claudeCLIAdapter) Cancel(_ context.Context, session Session, _ string) ([]activityshared.Event, error) {
	turn := a.takeActiveTurn(session.AgentSessionID)
	if turn == nil {
		return nil, ErrSessionNoActiveTurn
	}
	a.killTurnConnection(turn)
	return nil, nil
}

// CleanupLiveSessionResources reaps CLI processes whose Exec finished but
// whose close failed, so a physical process can never outlive its canonical
// turn after a failed close. It must never touch an in-flight turn: the
// periodic live-session reaper calls this on every sweep, and killing active
// turns here would interrupt healthy work (the controller settles
// cancellation through the ordinary cancel path instead).
func (a *claudeCLIAdapter) CleanupLiveSessionResources(ctx context.Context, limit int) LiveSessionResourceCleanupResult {
	var result LiveSessionResourceCleanupResult
	if a == nil || limit <= 0 {
		return result
	}
	select {
	case <-ctx.Done():
		return result
	default:
	}
	a.mu.Lock()
	var conns []ProcessConnection
	for conn := range a.detached {
		if len(conns) >= limit {
			break
		}
		conns = append(conns, conn)
		delete(a.detached, conn)
	}
	a.mu.Unlock()
	for _, conn := range conns {
		result.Attempted++
		killProcessConnection(conn)
		result.Cleaned++
	}
	return result
}

// rememberDetachedProcess tracks a process handle whose Exec finished but
// whose close failed. The set is bounded so a pathological runaway cannot
// grow memory without limit; the reaper owns killing what is tracked.
func (a *claudeCLIAdapter) rememberDetachedProcess(conn ProcessConnection) {
	if a == nil || conn == nil {
		return
	}
	a.mu.Lock()
	defer a.mu.Unlock()
	const maxDetachedProcesses = 32
	if len(a.detached) >= maxDetachedProcesses {
		return
	}
	a.detached[conn] = struct{}{}
}

func killProcessConnection(conn ProcessConnection) {
	if conn == nil {
		return
	}
	if graceful, ok := conn.(GracefulProcessConnection); ok {
		_ = graceful.Kill()
		return
	}
	_ = conn.Close()
}

func (a *claudeCLIAdapter) killTurnConnection(turn *claudeCLIActiveTurn) {
	if turn == nil || turn.conn == nil {
		return
	}
	killProcessConnection(turn.conn)
}

func (a *claudeCLIAdapter) registerActiveTurn(turn *claudeCLIActiveTurn) {
	if a == nil || turn == nil {
		return
	}
	a.mu.Lock()
	defer a.mu.Unlock()
	a.active[turn.agentSessionID] = turn
}

// takeActiveTurn removes the registered turn, if any. Exec deregisters
// itself this way so a completed turn can never be killed twice.
func (a *claudeCLIAdapter) takeActiveTurn(agentSessionID string) *claudeCLIActiveTurn {
	if a == nil {
		return nil
	}
	agentSessionID = strings.TrimSpace(agentSessionID)
	a.mu.Lock()
	defer a.mu.Unlock()
	turn := a.active[agentSessionID]
	if turn != nil {
		delete(a.active, agentSessionID)
	}
	return turn
}

func (a *claudeCLIAdapter) lookupPreparer() ProviderLaunchPreparer {
	a.mu.Lock()
	defer a.mu.Unlock()
	return a.preparer
}

// claudeCLITurnExecutor carries the per-Exec state: the provider turn id
// learned from system.init, whether the root provider turn start has been
// published yet, and the stream parser.
type claudeCLITurnExecutor struct {
	adapter    *claudeCLIAdapter
	session    Session
	turnID     string
	normalizer *acpTurnNormalizer
	parser     *claudeStreamParser

	// providerTurnID is the Claude Code session_id from system.init. It is
	// the durable resume evidence for this turn; when an older CLI omits it,
	// every root provider turn event falls back to the canonical turn id.
	providerTurnID string
	startedEmitted bool
	model          string

	// result records the terminal `result` line, if the CLI emitted one.
	result    *claudeStreamResult
	sawError  bool
	errorText string

	stderrTail string

	// killProcess is set when a fatal stream event (HTTP 429 api_retry) asks
	// the executor to stop waiting on Claude Code's internal retry loop.
	killProcess bool

	events     []activityshared.Event
	eventsMu   sync.Mutex
	emitEvents func([]activityshared.Event)
}

func (exec *claudeCLITurnExecutor) emit(next []activityshared.Event) {
	if len(next) == 0 {
		return
	}
	exec.eventsMu.Lock()
	exec.events = append(exec.events, next...)
	exec.eventsMu.Unlock()
	if exec.emitEvents != nil {
		exec.emitEvents(next)
	}
}

func (exec *claudeCLITurnExecutor) snapshotEvents() []activityshared.Event {
	exec.eventsMu.Lock()
	defer exec.eventsMu.Unlock()
	return append([]activityshared.Event(nil), exec.events...)
}

func (a *claudeCLIAdapter) Exec(
	ctx context.Context,
	session Session,
	content []PromptContentBlock,
	displayPrompt string,
	turnID string,
	emit EventSink,
	_ CommandSnapshotSink,
) ([]activityshared.Event, error) {
	explicitDisplayPrompt, visibleText := explicitAndVisiblePromptText(content, displayPrompt)
	exec := &claudeCLITurnExecutor{
		adapter:    a,
		session:    session,
		turnID:     strings.TrimSpace(turnID),
		normalizer: newACPTurnNormalizer(),
		parser:     newClaudeStreamParser(),
		// Before system.init arrives the canonical turn id is the only stable
		// identity available; it stays the fallback when the CLI omits one.
		providerTurnID: strings.TrimSpace(turnID),
		emitEvents:     emit,
	}

	// The user prompt message and turn.started do not need provider identity;
	// root_provider_turn.started waits for system.init so the durable rpt row
	// carries the real Claude Code session id whenever the CLI provides one.
	exec.emit([]activityshared.Event{
		newUserPromptActivityEvent(ctx, session, content, explicitDisplayPrompt, visibleText, exec.turnID, nil),
		newTurnActivityEvent(session, EventTurnStarted, exec.turnID, SessionStatusWorking, "", "", nil),
	})

	command, env, err := a.buildLaunch(ctx, session, visibleText)
	if err != nil {
		exec.failEarly(map[string]any{"error": err.Error()})
		return exec.snapshotEvents(), nil
	}
	spec, cleanup, err := prepareProviderLaunch(ctx, a.lookupPreparer(), session, ProcessSpec{
		Provider:           a.config.provider,
		AgentSessionID:     session.AgentSessionID,
		RootAgentSessionID: session.RootAgentSessionID,
		RoomID:             session.RoomID,
		CWD:                strings.TrimSpace(session.CWD),
		Command:            command,
		Env:                env,
	})
	if err != nil {
		return exec.failEarlySnapshot(map[string]any{"error": err.Error()}), nil
	}
	conn, err := a.transport.Start(ctx, spec)
	if err != nil {
		cleanupPreparedLaunch(cleanup)
		exec.failEarly(map[string]any{"error": err.Error()})
		return exec.snapshotEvents(), nil
	}
	conn = wrapProviderLaunchCleanup(conn, cleanup)
	// Print mode takes the prompt from argv (`-- <prompt>`) and never reads
	// stdin, so close it immediately: this mirrors the TS adapter's
	// `stdio: 'ignore'` spawn and avoids the CLI's "no stdin data received"
	// stall before it starts working.
	if graceful, ok := conn.(GracefulProcessConnection); ok {
		_ = graceful.CloseInput()
	}
	defer func() {
		if err := conn.Close(); err != nil {
			// A failed close can leave the managed process alive after its
			// turn settled; hand the handle to the reaper-owned detached set.
			a.rememberDetachedProcess(conn)
		}
	}()

	active := &claudeCLIActiveTurn{agentSessionID: session.AgentSessionID, turnID: exec.turnID, conn: conn}
	a.registerActiveTurn(active)
	defer a.takeActiveTurn(session.AgentSessionID)

	exec.run(ctx, conn)

	return exec.snapshotEvents(), nil
}

// failEarly settles a turn that never got a provider process: the provider
// turn lifecycle is opened and closed with the canonical turn id fallback so
// resume evidence and turn state stay consistent.
func (exec *claudeCLITurnExecutor) failEarly(metadata map[string]any) {
	exec.emit(exec.normalizer.FinishFailed(exec.session, exec.turnID))
	exec.ensureProviderTurnStarted()
	exec.emit([]activityshared.Event{claudeRootProviderTurnCompletedEvent(
		exec.session,
		exec.turnID,
		exec.providerTurnID,
		activityshared.TurnOutcomeFailed,
		metadata,
	)})
}

// failEarlySnapshot is the prepare-failure variant: unlike a spawn error the
// provider boundary never rejected the request, so the same visible failure
// settle applies.
func (exec *claudeCLITurnExecutor) failEarlySnapshot(metadata map[string]any) []activityshared.Event {
	exec.failEarly(metadata)
	return exec.snapshotEvents()
}

// run consumes process frames until EOF, ctx cancellation, or the exit frame,
// then settles the turn with the outcome the stream reported.
func (exec *claudeCLITurnExecutor) run(ctx context.Context, conn ProcessConnection) {
	var exitCode *int
	recv := conn.Recv
	if contextual, ok := conn.(ContextProcessConnection); ok {
		recv = func() (ProcessFrame, error) { return contextual.RecvContext(ctx) }
	}
	for {
		frame, err := recv()
		if err != nil {
			if errors.Is(err, context.Canceled) || errors.Is(err, context.DeadlineExceeded) {
				exec.handleCanceled(conn)
				return
			}
			if errors.Is(err, io.EOF) {
				break
			}
			exec.stderrTail = joinBoundedTail(exec.stderrTail, err.Error())
			break
		}
		switch {
		case len(frame.Stdout) > 0:
			exec.handleStreamEvents(exec.parser.push(frame.Stdout))
			if exec.killProcess {
				killProcessConnection(conn)
				break
			}
		case len(frame.Stderr) > 0:
			exec.stderrTail = joinBoundedTail(exec.stderrTail, string(frame.Stderr))
		case frame.ExitCode != nil:
			exitCode = frame.ExitCode
		}
		if exec.killProcess {
			break
		}
		if ctx.Err() != nil {
			exec.handleCanceled(conn)
			return
		}
	}
	exec.handleStreamEvents(exec.parser.flush())
	if ctx.Err() != nil {
		// The process can exit (kill → EOF) before the controller's cancel
		// reaches this goroutine; never settle that turn as a plain failure.
		exec.handleCanceled(conn)
		return
	}
	exec.settle(exitCode)
}

func (exec *claudeCLITurnExecutor) handleStreamEvents(streamEvents []claudeStreamEvent) {
	for _, event := range streamEvents {
		exec.handleStreamEvent(event)
	}
}

func (exec *claudeCLITurnExecutor) handleStreamEvent(event claudeStreamEvent) {
	switch event.kind {
	case "init":
		if event.sessionID != "" {
			exec.providerTurnID = event.sessionID
		}
		exec.model = event.model
		exec.ensureProviderTurnStarted()
	case "text":
		text := stripClaudeDiagnostics(event.text)
		if text == "" {
			return
		}
		exec.emit(exec.normalizer.AppendAssistantChunk(exec.session, exec.turnID, text))
	case "thinking":
		if strings.TrimSpace(event.text) == "" {
			return
		}
		exec.emit(exec.normalizer.AppendThinkingChunk(exec.session, exec.turnID, event.text))
	case "tool_start":
		update := map[string]any{
			"toolCallId": strings.TrimSpace(event.toolID),
			"title":      event.toolName,
			"name":       event.toolName,
			"kind":       "tool",
			"status":     string(activityshared.ActivityStatusRunning),
			"rawInput":   clonePayloadValue(event.toolInput),
		}
		if events, ok := exec.normalizer.StandardToolCallEvents(exec.session, exec.turnID, "tool_call", update); ok {
			exec.emit(events)
		}
	case "tool_end":
		status := string(activityshared.ActivityStatusCompleted)
		if event.toolError {
			status = string(activityshared.ActivityStatusFailed)
		}
		output := map[string]any{}
		if text := strings.TrimSpace(event.text); text != "" {
			output["stdout"] = text
		}
		update := map[string]any{
			"toolCallId": strings.TrimSpace(event.toolID),
			"title":      event.toolName,
			"name":       event.toolName,
			"kind":       "tool",
			"status":     status,
			"rawOutput":  output,
		}
		if events, ok := exec.normalizer.StandardToolCallEvents(exec.session, exec.turnID, "tool_call_update", update); ok {
			exec.emit(events)
		}
	case "result":
		result := event.result
		exec.result = &result
	case "error":
		exec.sawError = true
		exec.errorText = event.message
		if event.killProcess {
			exec.killProcess = true
		}
	}
}

// ensureProviderTurnStarted publishes root_provider_turn.started exactly once,
// with the Claude Code session id when system.init supplied one and the
// canonical turn id as fallback otherwise.
func (exec *claudeCLITurnExecutor) ensureProviderTurnStarted() {
	if exec.startedEmitted {
		return
	}
	exec.startedEmitted = true
	ctx, ok := activityEventContext(exec.session, "claude-cli:provider-turn-started:"+exec.turnID, exec.turnID)
	if !ok {
		return
	}
	exec.emit([]activityshared.Event{activityshared.NewRootProviderTurnStarted(ctx, exec.turnID, exec.providerTurnID)})
}

func (exec *claudeCLITurnExecutor) settle(exitCode *int) {
	exec.ensureProviderTurnStarted()
	metadata := exec.resultMetadata()
	switch {
	case exec.sawError:
		exec.failTurn(metadata, exec.errorText)
	case exec.result != nil && exec.result.isError:
		exec.failTurn(metadata, exec.result.text)
	case exec.result != nil && exec.result.subtype == "error":
		exec.failTurn(metadata, exec.result.text)
	case exec.result == nil && exitCode != nil && *exitCode != 0:
		message := fmt.Sprintf("claude exited with code %d", *exitCode)
		if tail := strings.TrimSpace(exec.stderrTail); tail != "" {
			message = message + ": " + tail
		}
		exec.failTurn(metadata, message)
	case exec.result == nil && !exec.normalizer.HasObservableOutput():
		message := "claude ended the turn without a result or assistant output"
		if tail := strings.TrimSpace(exec.stderrTail); tail != "" {
			message = message + ": " + tail
		}
		exec.failTurn(metadata, message)
	default:
		if exec.result != nil && !exec.parser.sawPartialText {
			if text := strings.TrimSpace(exec.result.text); text != "" && !exec.normalizer.HasAssistantOutput() {
				exec.emit(exec.normalizer.AppendAssistantSnapshot(exec.session, exec.turnID, text, ""))
			}
		}
		exec.emit(exec.normalizer.FinishCompleted(exec.session, exec.turnID))
		if exec.result != nil && exec.result.subtype == "max_turns" {
			metadata["stopReason"] = "max_turns"
		}
		exec.emit([]activityshared.Event{claudeRootProviderTurnCompletedEvent(
			exec.session,
			exec.turnID,
			exec.providerTurnID,
			activityshared.TurnOutcomeCompleted,
			metadata,
		)})
	}
}

func (exec *claudeCLITurnExecutor) failTurn(metadata map[string]any, message string) {
	metadata = clonePayload(metadata)
	if metadata == nil {
		metadata = map[string]any{}
	}
	if strings.TrimSpace(message) == "" {
		message = "Claude Code run failed"
	}
	metadata["error"] = strings.TrimSpace(message)
	if tail := strings.TrimSpace(exec.stderrTail); tail != "" {
		if _, exists := metadata["stderr"]; !exists {
			metadata["stderr"] = tail
		}
	}
	if !exec.normalizer.HasAssistantOutput() {
		exec.emit(exec.normalizer.FailAssistantSnapshot(exec.session, exec.turnID, strings.TrimSpace(message), ""))
	}
	exec.emit(exec.normalizer.FinishFailed(exec.session, exec.turnID))
	exec.emit([]activityshared.Event{claudeRootProviderTurnCompletedEvent(
		exec.session,
		exec.turnID,
		exec.providerTurnID,
		activityshared.TurnOutcomeFailed,
		metadata,
	)})
}

func (exec *claudeCLITurnExecutor) handleCanceled(conn ProcessConnection) {
	if graceful, ok := conn.(GracefulProcessConnection); ok {
		_ = graceful.Kill()
	} else {
		_ = conn.Close()
	}
	exec.ensureProviderTurnStarted()
	exec.emit(exec.normalizer.FinishInterrupted(exec.session, exec.turnID, "canceled"))
	exec.emit([]activityshared.Event{claudeRootProviderTurnCompletedEvent(
		exec.session,
		exec.turnID,
		exec.providerTurnID,
		activityshared.TurnOutcomeCanceled,
		map[string]any{"error": "canceled"},
	)})
}

func (exec *claudeCLITurnExecutor) resultMetadata() map[string]any {
	metadata := map[string]any{}
	if exec.model != "" {
		metadata["model"] = exec.model
	}
	if exec.result == nil {
		return metadata
	}
	if len(exec.result.usage) > 0 {
		metadata["usage"] = clonePayload(exec.result.usage)
	}
	if exec.result.durationMS > 0 {
		metadata["durationMs"] = exec.result.durationMS
	}
	if exec.result.numTurns > 0 {
		metadata["numTurns"] = exec.result.numTurns
	}
	if exec.result.totalCostUSD > 0 {
		metadata["totalCostUsd"] = exec.result.totalCostUSD
	}
	if subtype := strings.TrimSpace(exec.result.subtype); subtype != "" && subtype != "success" {
		metadata["stopReason"] = subtype
	}
	return metadata
}

func claudeRootProviderTurnCompletedEvent(
	session Session,
	rootTurnID string,
	providerTurnID string,
	outcome activityshared.TurnOutcome,
	metadata map[string]any,
) activityshared.Event {
	ctx, ok := activityEventContext(session, "claude-cli:provider-turn-completed:"+strings.TrimSpace(rootTurnID), rootTurnID)
	if !ok {
		return activityshared.Event{}
	}
	event := activityshared.NewRootProviderTurnCompleted(ctx, rootTurnID, providerTurnID, outcome)
	event.Payload.Metadata = clonePayload(metadata)
	return event
}

// buildLaunch resolves the executable through the runtime command adapter and
// assembles the argv. The prompt travels as one positional argument after
// `--` (Claude Code print mode), never through a shell: no sh -c / cmd /c
// string is constructed anywhere on this path.
//
// When session.RuntimeContext carries agoraxMissionMcp {endpoint, runToken},
// a per-run mcp-config.json is written and --mcp-config + HERMES_MCP_TOKEN
// are injected (parity with the TypeScript ClaudeCodeAdapter).
func (a *claudeCLIAdapter) buildLaunch(
	ctx context.Context,
	session Session,
	prompt string,
) ([]string, []string, error) {
	if strings.TrimSpace(prompt) == "" {
		return nil, nil, errors.New("claude prompt text is required")
	}
	command := append([]string(nil), a.config.command...)
	env := claudeCLIEnv(session, a.host)
	if a.commandResolver != nil {
		resolved, err := a.commandResolver(ctx, a.config.provider)
		if err != nil {
			return nil, nil, err
		}
		if len(resolved.Command) > 0 {
			command = append([]string(nil), resolved.Command...)
		}
		env = append(env, resolved.Env...)
	}
	argv, err := claudeCLIArgv(session, command[0], a.permissionArgv(session), a.config.declaredArgs(), prompt)
	if err != nil {
		return nil, nil, err
	}
	mcpConfigPath, mcpToken, mcpErr := writeAgoraxMissionMcpConfig(session)
	if mcpErr != nil {
		return nil, nil, mcpErr
	}
	if mcpConfigPath != "" {
		// Insert --mcp-config before the trailing `-- <prompt>` pair.
		insertAt := len(argv) - 2
		if insertAt < 1 {
			insertAt = len(argv)
		}
		withMcp := make([]string, 0, len(argv)+2)
		withMcp = append(withMcp, argv[:insertAt]...)
		withMcp = append(withMcp, "--mcp-config", mcpConfigPath)
		withMcp = append(withMcp, argv[insertAt:]...)
		argv = withMcp
		if mcpToken != "" {
			env = append(env, "HERMES_MCP_TOKEN="+mcpToken)
		}
	}
	return argv, env, nil
}

// writeAgoraxMissionMcpConfig materializes a per-run Claude MCP config when
// RuntimeContext.agoraxMissionMcp is present. Returns ("", "", nil) when
// no MCP handshake was attached.
func writeAgoraxMissionMcpConfig(session Session) (configPath string, runToken string, err error) {
	raw, ok := session.RuntimeContext["agoraxMissionMcp"]
	if !ok || raw == nil {
		return "", "", nil
	}
	asMap, ok := raw.(map[string]any)
	if !ok {
		return "", "", nil
	}
	endpoint, _ := asMap["endpoint"].(string)
	token, _ := asMap["runToken"].(string)
	endpoint = strings.TrimSpace(endpoint)
	token = strings.TrimSpace(token)
	if endpoint == "" || token == "" {
		return "", "", nil
	}
	dir, err := os.MkdirTemp("", "agorax-claude-mcp-*")
	if err != nil {
		return "", "", fmt.Errorf("create mcp config dir: %w", err)
	}
	path := filepath.Join(dir, "mcp-config.json")
	body, err := json.Marshal(map[string]any{
		"mcpServers": map[string]any{
			"hermes-workspace": map[string]any{
				"url": endpoint,
				"headers": map[string]string{
					"Authorization": "Bearer ${HERMES_MCP_TOKEN}",
				},
			},
		},
	})
	if err != nil {
		return "", "", err
	}
	if err := os.WriteFile(path, body, 0o600); err != nil {
		return "", "", fmt.Errorf("write mcp config: %w", err)
	}
	return path, token, nil
}

// permissionArgv resolves the permission-policy argv segment for one launch:
// session setting first (validated against the descriptor PermissionModes),
// then the descriptor DefaultPermissionModeID, then one explicit fallback.
func (a *claudeCLIAdapter) permissionArgv(session Session) []string {
	modeID := a.validatedPermissionModeID(session.PermissionModeID)
	argv := claudePermissionArgv(modeID, a.config.declaredArgs())
	if argv != nil {
		return argv
	}
	argv = claudePermissionArgv(a.validatedPermissionModeID(a.config.defaultPermissionModeID), nil)
	if argv != nil {
		return argv
	}
	// Fallback: a managed print-mode run (`claude -p`) cannot surface Claude
	// Code's interactive permission dialog — stdin is ignored in print mode —
	// and every configuration source above resolved to the interactive
	// "default" mode, which would hang the turn waiting for a prompt that can
	// never be answered. Bypassing permissions here is the single, explicit
	// default for a missing configuration decision; it is traceable (this is
	// the only fallback site) and never a scattered flag literal.
	return []string{claudeSkipPermissionsFlag}
}

// validatedPermissionModeID admits only ids the descriptor declares. An
// unknown or empty id resolves to "" so the pure function treats it as "no
// conclusion" instead of guessing.
func (a *claudeCLIAdapter) validatedPermissionModeID(modeID string) string {
	modeID = strings.TrimSpace(modeID)
	if modeID == "" {
		return ""
	}
	if len(a.config.permissionModeIDs) == 0 {
		return ""
	}
	if a.config.permissionModeIDs[modeID] {
		return modeID
	}
	return ""
}

// claudeCLIArgv mirrors the TypeScript CLI adapter (claude-code-adapter.ts):
// stream-json partial output, print mode, permission prompts decided up
// front by the pure policy function, model/effort from session settings, and
// the prompt after `--`. The prompt is exactly one argv element; no shell
// string or quoting is constructed anywhere on this path.
func claudeCLIArgv(session Session, executable string, permissionArgv []string, declaredArgs []string, prompt string) ([]string, error) {
	if strings.TrimSpace(executable) == "" {
		return nil, errors.New("claude executable is required")
	}
	if strings.TrimSpace(prompt) == "" {
		return nil, errors.New("claude prompt text is required")
	}
	argv := []string{executable}
	argv = append(argv, permissionArgv...)
	if !claudeArgsDeclarePermissionPolicy(declaredArgs) {
		// Declaration-owned args that do not choose a permission policy
		// still reach the CLI verbatim.
		argv = append(argv, declaredArgs...)
	}
	argv = append(argv,
		"-p",
		"--output-format", "stream-json",
		"--verbose",
		"--include-partial-messages",
	)
	if model := strings.TrimSpace(session.SettingsValue().Model); model != "" {
		argv = append(argv, "--model", model)
	}
	if effort := claudeEffortFlag(session.SettingsValue().ReasoningEffort); effort != "" {
		argv = append(argv, "--effort", effort)
	}
	argv = append(argv, "--", prompt)
	return argv, nil
}

// claudeEffortFlag maps composer effort values onto --effort. "adaptive"
// degrades to medium for the Claude Code CLI, matching the TS adapter.
func claudeEffortFlag(effort string) string {
	switch strings.ToLower(strings.TrimSpace(effort)) {
	case "low", "medium", "high", "xhigh", "max":
		return strings.ToLower(strings.TrimSpace(effort))
	case "adaptive":
		return "medium"
	default:
		return ""
	}
}

func claudeCLIEnv(session Session, host HostMetadata) []string {
	env := []string{
		gitTerminalPromptEnv,
		gitOptionalLocksEnv,
		"NO_BROWSER=1",
		// Keep unknown-model window enforcement off for proxy model names
		// (same contract as the TS adapter's spawn env).
		"CLAUDE_CODE_DISABLE_UNKNOWN_MODEL_WINDOW_ENFORCEMENT=1",
	}
	// `claude -p` does not reliably apply ~/.claude/settings.json env for
	// auth, so the settings env block is injected explicitly; explicit
	// session env still wins over it.
	env = append(env, claudeCodeSettingsEnv()...)
	env = append(env, workspaceEnv(session, host)...)
	env = append(env, session.Env...)
	env = append(env, claudeAuthMirrorEnv(env)...)
	return env
}

// joinBoundedTail keeps the last chunk of CLI stderr (bounded) for failure
// diagnostics without pinning the whole stream in memory.
func joinBoundedTail(tail string, chunk string) string {
	const maxStderrTailBytes = 4000
	combined := tail + chunk
	if len(combined) > maxStderrTailBytes {
		combined = combined[len(combined)-maxStderrTailBytes:]
	}
	return combined
}

// isClaudeDiagnostic mirrors the TS adapter: proxy model names can make the
// CLI print a non-fatal unrecognized-model warning that must never land in
// the transcript as assistant text.
func isClaudeDiagnostic(message string) bool {
	return strings.Contains(message, "[claude-code:unrecognized_model]") ||
		strings.Contains(message, "is not a model this version of Claude Code recognizes")
}

func stripClaudeDiagnostics(text string) string {
	if !isClaudeDiagnostic(text) && !strings.Contains(text, "[claude-code:") {
		return text
	}
	lines := strings.Split(text, "\n")
	kept := lines[:0]
	for _, line := range lines {
		if isClaudeDiagnostic(line) || strings.Contains(line, "[claude-code:") {
			continue
		}
		kept = append(kept, line)
	}
	return strings.TrimLeft(strings.Join(kept, "\n"), "\n")
}

func (a *claudeCLIAdapter) String() string {
	if a == nil {
		return "claude-cli"
	}
	return fmt.Sprintf("claude-cli(%s)", a.config.provider)
}
