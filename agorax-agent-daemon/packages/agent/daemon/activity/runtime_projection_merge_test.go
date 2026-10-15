package agentsessionstore

import (
	"encoding/json"
	"testing"
)

func TestRuntimeTimelineItemsForDisplayDoesNotOverwriteRichOutputWithShallowLocalStatus(t *testing.T) {
	t.Parallel()

	items := RuntimeTimelineItemsForDisplay(
		[]WorkspaceAgentTimelineItem{{
			ID:             11,
			AgentSessionID: "agent-1",
			EventID:        "call-event-1",
			ItemType:       "call",
			CallID:         "tool-1",
			CallType:       "tool",
			Name:           "Run command",
			Status:         "completed",
			Payload: map[string]any{
				"toolName": "Bash",
				"output": map[string]any{
					"stdout": "README.md\n",
				},
				"error": map[string]any{
					"stderr": "warning: truncated\n",
				},
				"content": []any{
					map[string]any{"type": "text", "text": "README.md\n"},
				},
			},
			OccurredAtUnixMS: 20,
		}},
		[]WorkspaceAgentTimelineItem{{
			AgentSessionID: "agent-1",
			EventID:        "call-event-1",
			ItemType:       "call",
			CallID:         "tool-1",
			CallType:       "tool",
			Name:           "Run command",
			Status:         "completed",
			Payload: map[string]any{
				"toolName": "Bash",
				"output": map[string]any{
					"sessionUpdate": "tool_call_update",
					"status":        "completed",
					"toolCallId":    "tool-1",
				},
			},
			OccurredAtUnixMS: 21,
		}},
		0,
		0,
	)

	if len(items) != 1 {
		t.Fatalf("items = %#v, want one merged call", items)
	}
	output, ok := items[0].Payload["output"].(map[string]any)
	if !ok {
		t.Fatalf("payload = %#v, want output map", items[0].Payload)
	}
	if got := output["stdout"]; got != "README.md\n" {
		t.Fatalf("output = %#v, want durable stdout preserved", output)
	}
	if got := output["status"]; got != "completed" {
		t.Fatalf("output = %#v, want local status merged", output)
	}
	errorPayload, ok := items[0].Payload["error"].(map[string]any)
	if !ok {
		t.Fatalf("payload = %#v, want error map", items[0].Payload)
	}
	if got := errorPayload["stderr"]; got != "warning: truncated\n" {
		t.Fatalf("error = %#v, want durable stderr preserved", errorPayload)
	}
	content, ok := items[0].Payload["content"].([]any)
	if !ok || len(content) != 1 {
		t.Fatalf("payload = %#v, want content array preserved", items[0].Payload)
	}
	if got := items[0].Payload["toolName"]; got != "Bash" {
		t.Fatalf("payload = %#v, want canonical toolName preserved", items[0].Payload)
	}
}

func TestRuntimeTimelineItemsForDisplayPrefersDurableCompletedStateOverStaleLocalStarted(t *testing.T) {
	t.Parallel()

	items := RuntimeTimelineItemsForDisplay(
		[]WorkspaceAgentTimelineItem{{
			ID:             11,
			AgentSessionID: "agent-1",
			EventID:        "call-event-1",
			ItemType:       "call.completed",
			CallID:         "tool-1",
			CallType:       "tool",
			Name:           "Run command",
			Status:         "completed",
			Payload: map[string]any{
				"toolName": "Bash",
				"input": map[string]any{
					"command": "pwd",
				},
				"output": map[string]any{
					"stdout": "/workspace\n",
				},
			},
			OccurredAtUnixMS: 20,
		}},
		[]WorkspaceAgentTimelineItem{{
			AgentSessionID: "agent-1",
			EventID:        "call-event-1",
			ItemType:       "call.started",
			CallID:         "tool-1",
			CallType:       "tool",
			Name:           "Run command",
			Status:         "running",
			Payload: map[string]any{
				"toolName": "Bash",
				"input": map[string]any{
					"command": "pwd",
				},
			},
			OccurredAtUnixMS: 10,
		}},
		0,
		0,
	)

	if len(items) != 1 {
		t.Fatalf("items = %#v, want one merged call", items)
	}
	if got := items[0].ItemType; got != "call.completed" {
		t.Fatalf("item type = %q, want durable completed type", got)
	}
	if got := items[0].Status; got != "completed" {
		t.Fatalf("status = %q, want durable completed status", got)
	}
	output, ok := items[0].Payload["output"].(map[string]any)
	if !ok {
		t.Fatalf("payload = %#v, want output map", items[0].Payload)
	}
	if got := output["stdout"]; got != "/workspace\n" {
		t.Fatalf("output = %#v, want durable stdout preserved", output)
	}
}

func TestRuntimeTimelineItemsForDisplayMergesTerminalStateByStableCallIDAcrossDifferentEventIDs(t *testing.T) {
	t.Parallel()

	items := RuntimeTimelineItemsForDisplay(
		[]WorkspaceAgentTimelineItem{{
			ID:             11,
			AgentSessionID: "agent-1",
			EventID:        "upstream-started",
			ItemType:       "call.started",
			CallID:         "call_e4605c2992e74c85a256db88",
			CallType:       "tool",
			Name:           "Run command",
			Status:         "running",
			Payload: map[string]any{
				"toolName": "Bash",
				"input": map[string]any{
					"command": "touch /workspace/todo-list/test.txt 2>&1",
				},
			},
			OccurredAtUnixMS: 10,
		}},
		[]WorkspaceAgentTimelineItem{{
			AgentSessionID: "agent-1",
			EventID:        "local-completed",
			ItemType:       "call.completed",
			CallID:         "call_e4605c2992e74c85a256db88",
			CallType:       "tool",
			Name:           "Run command",
			Status:         "completed",
			Payload: map[string]any{
				"toolName": "Bash",
				"callId":   "call_e4605c2992e74c85a256db88",
				"input": map[string]any{
					"command": "touch /workspace/todo-list/test.txt 2>&1",
				},
				"output": map[string]any{
					"status": "completed",
				},
			},
			OccurredAtUnixMS: 20,
		}},
		0,
		0,
	)

	if len(items) != 1 {
		t.Fatalf("items = %#v, want one merged call", items)
	}
	if got := items[0].ItemType; got != "call.completed" {
		t.Fatalf("item type = %q, want completed terminal state", got)
	}
	if got := items[0].Status; got != "completed" {
		t.Fatalf("status = %q, want completed terminal state", got)
	}
	if got := items[0].CallID; got != "call_e4605c2992e74c85a256db88" {
		t.Fatalf("call id = %q, want stable call id preserved", got)
	}
}

func TestRuntimeTimelineItemsForDisplayMergesTerminalStateByCallSignatureAcrossDifferentEventIDs(t *testing.T) {
	t.Parallel()

	items := RuntimeTimelineItemsForDisplay(
		[]WorkspaceAgentTimelineItem{{
			ID:             11,
			AgentSessionID: "agent-1",
			EventID:        "upstream-started",
			ItemType:       "call.started",
			CallID:         "tool.Bash",
			CallType:       "tool",
			Name:           "Bash",
			Status:         "running",
			Payload: map[string]any{
				"toolName": "Bash",
				"input": map[string]any{
					"command": "cat << 'EOF' > /workspace/todo-list/src/App.jsx",
				},
			},
			OccurredAtUnixMS: 10,
		}},
		[]WorkspaceAgentTimelineItem{{
			AgentSessionID: "agent-1",
			EventID:        "local-completed",
			ItemType:       "call.completed",
			CallID:         "tool.Bash",
			CallType:       "tool",
			Name:           "Bash",
			Status:         "completed",
			Payload: map[string]any{
				"toolName": "Bash",
				"input": map[string]any{
					"command": "cat << 'EOF' > /workspace/todo-list/src/App.jsx",
				},
				"output": map[string]any{
					"status": "completed",
				},
			},
			OccurredAtUnixMS: 20,
		}},
		0,
		0,
	)

	if len(items) != 1 {
		t.Fatalf("items = %#v, want one merged call", items)
	}
	if got := items[0].ItemType; got != "call.completed" {
		t.Fatalf("item type = %q, want completed terminal state", got)
	}
	if got := items[0].Status; got != "completed" {
		t.Fatalf("status = %q, want completed terminal state", got)
	}
}

func TestRuntimeTimelineItemsForDisplayMergesRealExportedCallE460Records(t *testing.T) {
	t.Parallel()

	startedPayload := mustDecodeTimelinePayload(t, `{"tool": "Bash", "input": {"command": "touch /workspace/todo-list/test.txt 2>&1", "description": "Test write permission"}, "paths": ["/workspace/todo-list/test.txt", ">", "&1"], "callID": "call_e4605c2992e74c85a256db88", "command": "touch /workspace/todo-list/test.txt 2>&1", "toolName": "exec_command", "activityKind": "write_file", "fileChangeKind": "added"}`)
	completedPayload := mustDecodeTimelinePayload(t, `{"acp": {"kind": "execute", "sessionUpdate": "tool_call_update"}, "kind": "execute", "name": "Bash", "input": {"command": "touch /workspace/todo-list/test.txt 2>&1", "description": "Test write permission"}, "callId": "call_e4605c2992e74c85a256db88", "output": {"output": "(Bash completed with no output)", "content": [{"type": "terminal", "terminalId": "call_e4605c2992e74c85a256db88"}]}, "status": "completed", "content": [{"type": "terminal", "terminalId": "call_e4605c2992e74c85a256db88"}], "callType": "tool", "metadata": {"claudeToolResponse": {"stderr": "", "stdout": "", "isImage": false, "interrupted": false, "noOutputExpected": true}}, "toolName": "Bash"}`)

	items := RuntimeTimelineItemsForDisplay(
		[]WorkspaceAgentTimelineItem{{
			ID:               262415,
			RoomID:           "0727f452-b043-4474-8e68-a291ff2ed24a",
			AgentSessionID:   "a2c9fbe1-8007-4aff-9e9e-06fa2fa6f0f9",
			TurnID:           "claude-code:a2c9fbe1-8007-4aff-9e9e-06fa2fa6f0f9:6:turn:59838fd8a29f",
			EventID:          "claude-code:a2c9fbe1-8007-4aff-9e9e-06fa2fa6f0f9:call:call_e4605c2992e74c85a256db88",
			ActorType:        "agent",
			ActorID:          "claude-code",
			ItemType:         "call.started",
			CallType:         "tool",
			CallID:           "call_e4605c2992e74c85a256db88",
			Name:             "Bash",
			Status:           "running",
			EventSource:      "agent",
			Payload:          startedPayload,
			OccurredAtUnixMS: 1748351667849,
		}},
		[]WorkspaceAgentTimelineItem{{
			ID:               262412,
			RoomID:           "0727f452-b043-4474-8e68-a291ff2ed24a",
			AgentSessionID:   "abd03db5-0ae0-4d70-9d74-73e7328e0a44",
			TurnID:           "34416d0c-392d-409c-a1dc-cdc2fe7f62e1",
			EventID:          "claude-code:a2c9fbe1-8007-4aff-9e9e-06fa2fa6f0f9:call:call_e4605c2992e74c85a256db88",
			ActorType:        "agent",
			ActorID:          "claude-code",
			ItemType:         "call.completed",
			CallType:         "tool",
			CallID:           "call_e4605c2992e74c85a256db88",
			Name:             "Bash",
			Status:           "completed",
			EventSource:      "runtime",
			Payload:          completedPayload,
			OccurredAtUnixMS: 1748351674549,
		}},
		0,
		0,
	)

	if len(items) != 1 {
		t.Fatalf("items = %#v, want one merged call", items)
	}
	item := items[0]
	if got := item.ItemType; got != "call.completed" {
		t.Fatalf("item type = %q, want completed terminal state", got)
	}
	if got := item.Status; got != "completed" {
		t.Fatalf("status = %q, want completed terminal state", got)
	}
	if got := payloadStringValue(item.Payload, "activityKind"); got != "write_file" {
		t.Fatalf("payload = %#v, want started-side activityKind preserved", item.Payload)
	}
	if got := payloadStringValue(item.Payload, "fileChangeKind"); got != "added" {
		t.Fatalf("payload = %#v, want started-side fileChangeKind preserved", item.Payload)
	}
	output, ok := item.Payload["output"].(map[string]any)
	if !ok {
		t.Fatalf("payload = %#v, want completed output preserved", item.Payload)
	}
	if got := output["output"]; got != "(Bash completed with no output)" {
		t.Fatalf("output = %#v, want completed output text", output)
	}
}

func TestRuntimeTimelineItemsForDisplayMergesRealJSONLStartedWithCompletedResult(t *testing.T) {
	t.Parallel()

	command := `cat << 'EOF' > /workspace/todo-list/src/App.jsx
import { useState, useEffect } from 'react'
import './App.css'

function App() {
  const [todos, setTodos] = useState(() => {
    const saved = localStorage.getItem('todos')
    return saved ? JSON.parse(saved) : []
  })
  const [input, setInput] = useState('')

  useEffect(() => {
    localStorage.setItem('todos', JSON.stringify(todos))
  }, [todos])

  const addTodo = () => {
    const text = input.trim()
    if (!text) return
    setTodos([...todos, { id: Date.now(), text, done: false }])
    setInput('')
  }

  const toggleTodo = (id) => {
    setTodos(todos.map(t => t.id === id ? { ...t, done: !t.done } : t))
  }

  const removeTodo = (id) => {
    setTodos(todos.filter(t => t.id !== id))
  }

  const clearDone = () => {
    setTodos(todos.filter(t => !t.done))
  }

  const handleKey = (e) => {
    if (e.key === 'Enter') addTodo()
  }

  return (
    <div className="container">
      <h1>Todo List</h1>
      <div className="input-row">
        <input
          type="text"
          placeholder="添加新任务..."
          value={input}
          onChange={e => setInput(e.target.value)}
          onKeyDown={handleKey}
        />
        <button onClick={addTodo}>添加</button>
      </div>

      <ul className="todo-list">
        {todos.map(todo => (
          <li key={todo.id} className={todo.done ? 'done' : ''}>
            <span className="check" onClick={() => toggleTodo(todo.id)}>
              {todo.done ? '✓' : '○'}
            </span>
            <span className="text">{todo.text}</span>
            <button className="del" onClick={() => removeTodo(todo.id)}>×</button>
          </li>
        ))}
      </ul>

      {todos.length > 0 && (
        <div className="footer">
          <span>{todos.filter(t => !t.done).length} 项待完成</span>
          <button onClick={clearDone}>清除已完成</button>
        </div>
      )}
    </div>
  )
}

export default App
EOF`
	startedPayload := map[string]any{
		"tool": "Bash",
		"input": map[string]any{
			"command":     command,
			"description": "Write App.jsx component",
		},
	}
	completedPayload := map[string]any{
		"toolName": "Bash",
		"callId":   "call_b53acce3090e4d2d8b84e978",
		"input": map[string]any{
			"command":     command,
			"description": "Write App.jsx component",
		},
		"output": map[string]any{
			"output": "(Bash completed with no output)",
		},
		"status": "completed",
	}

	items := RuntimeTimelineItemsForDisplay(
		[]WorkspaceAgentTimelineItem{{
			ID:             262437,
			AgentSessionID: "a2c9fbe1-8007-4aff-9e9e-06fa2fa6f0f9",
			TurnID:         "claude-code:a2c9fbe1-8007-4aff-9e9e-06fa2fa6f0f9:6:turn:59838fd8a29f",
			EventID:        "claude-code:a2c9fbe1-8007-4aff-9e9e-06fa2fa6f0f9:call:call_b53acce3090e4d2d8b84e978",
			ItemType:       "call.started",
			CallType:       "tool",
			CallID:         "call_b53acce3090e4d2d8b84e978",
			Name:           "Bash",
			Status:         "running",
			Payload:        startedPayload,
		}},
		[]WorkspaceAgentTimelineItem{{
			AgentSessionID: "abd03db5-0ae0-4d70-9d74-73e7328e0a44",
			TurnID:         "34416d0c-392d-409c-a1dc-cdc2fe7f62e1",
			EventID:        "claude-code:a2c9fbe1-8007-4aff-9e9e-06fa2fa6f0f9:call:call_b53acce3090e4d2d8b84e978",
			ItemType:       "call.completed",
			CallType:       "tool",
			CallID:         "call_b53acce3090e4d2d8b84e978",
			Name:           "Bash",
			Status:         "completed",
			Payload:        completedPayload,
		}},
		262435,
		20,
	)

	if len(items) != 1 {
		t.Fatalf("items = %#v, want one merged call after cursor filter", items)
	}
	item := items[0]
	if got := item.ItemType; got != "call.completed" {
		t.Fatalf("item type = %q, want completed state after merge", got)
	}
	if got := item.Status; got != "completed" {
		t.Fatalf("status = %q, want completed state after merge", got)
	}
	if got := payloadStringValue(item.Payload, "tool"); got != "Bash" {
		t.Fatalf("payload = %#v, want upstream tool metadata preserved", item.Payload)
	}
	output, ok := item.Payload["output"].(map[string]any)
	if !ok || output["output"] != "(Bash completed with no output)" {
		t.Fatalf("payload = %#v, want completed tool_result output", item.Payload)
	}
}

func mustDecodeTimelinePayload(t *testing.T, raw string) map[string]any {
	t.Helper()

	var payload map[string]any
	if err := json.Unmarshal([]byte(raw), &payload); err != nil {
		t.Fatalf("decode payload: %v", err)
	}
	return payload
}
