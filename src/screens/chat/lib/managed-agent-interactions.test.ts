import { describe, expect, it } from 'vitest'
import type { AgentActivityInteraction } from '@agorax/agent-activity-core'
import {
  normalizeManagedAgentQuestions,
  projectManagedAgentInteraction,
  projectPendingApprovalsFromToolCallMessages,
  settleManagedAgentInteraction,
} from './managed-agent-interactions'
import type { AgentActivityMessage } from '@agorax/agent-activity-core'

function interaction(
  overrides: Partial<AgentActivityInteraction> &
    Pick<AgentActivityInteraction, 'kind'>,
): AgentActivityInteraction {
  return {
    agentSessionId: 'session-1',
    requestId: 'request-1',
    turnId: 'turn-1',
    status: 'pending',
    createdAtUnixMs: 1,
    updatedAtUnixMs: 1,
    ...overrides,
  }
}

describe('projectManagedAgentInteraction — approval', () => {
  it('projects canonical daemon approval fields (toolCall title/input + metadata.actions)', () => {
    const card = projectManagedAgentInteraction(
      interaction({
        kind: 'approval',
        toolName: 'shell',
        input: {
          requestId: 'request-1',
          toolCall: {
            title: 'Run command?',
            input: { command: 'npm test', path: 'ignored-second-key' },
          },
          options: [{ optionId: 'allow-once', name: 'Allow', kind: 'allowOnce' }],
        },
        metadata: {
          callType: 'approval',
          actions: [
            { id: 'allow-once', label: 'Allow', semantic: 'approve' },
            { id: 'deny-and-stop', label: 'Deny and stop', semantic: 'deny_and_stop' },
          ],
        },
      }),
    )
    expect(card).toEqual({
      agentSessionId: 'session-1',
      turnId: 'turn-1',
      requestId: 'request-1',
      kind: 'approval',
      status: 'pending',
      title: 'Run command?',
      detail: 'npm test',
      actions: [
        { id: 'allow-once', label: 'Allow', semantic: 'approve' },
        { id: 'deny-and-stop', label: 'Deny and stop', semantic: 'deny_and_stop' },
      ],
      questions: [],
      plan: null,
      supportsResponse: true,
    })
  })

  it('falls back to canonical input.options when metadata.actions is absent', () => {
    const card = projectManagedAgentInteraction(
      interaction({
        kind: 'approval',
        toolName: 'shell',
        input: {
          options: [
            { optionId: 'approve', name: 'Yes', kind: 'allowOnce' },
            { id: 'reject', label: 'No', kind: 'rejectAlways' },
          ],
        },
        metadata: { callType: 'approval' },
      }),
    )
    expect(card?.actions).toEqual([
      { id: 'approve', label: 'Yes', semantic: 'approve' },
      { id: 'reject', label: 'No', semantic: 'deny_and_stop' },
    ])
  })

  it('fails closed when no canonical actions exist', () => {
    expect(
      projectManagedAgentInteraction(interaction({ kind: 'approval' })),
    ).toBeNull()
  })
})

describe('projectManagedAgentInteraction — question', () => {
  it('normalizes input.questions and keeps deterministic ids for missing ones', () => {
    const card = projectManagedAgentInteraction(
      interaction({
        kind: 'question',
        toolName: 'AskUserQuestion',
        input: {
          questions: [
            {
              header: 'Scope',
              question: 'Which scope?',
              multiSelect: true,
              options: [
                { label: 'A', description: 'Option A' },
                { id: 'opt-b', label: 'B' },
              ],
            },
            {
              id: 'q2',
              question: 'Free-form note?',
              allowFreeText: false,
            },
          ],
        },
        metadata: { callType: 'interactive', interactiveKind: 'ask-user' },
      }),
    )
    expect(card?.kind).toBe('question')
    expect(card?.supportsResponse).toBe(true)
    expect(card?.questions).toHaveLength(2)
    const [first, second] = card!.questions
    expect(first?.header).toBe('Scope')
    expect(first?.multiSelect).toBe(true)
    expect(first?.options[0]?.label).toBe('A')
    expect(first?.options[0]?.id).toMatch(/^contract-option-/)
    expect(first?.options[1]?.id).toBe('opt-b')
    expect(second?.id).toBe('q2')
    expect(second?.allowFreeText).toBe(false)
  })

  it('fails closed when input.questions is missing or empty', () => {
    expect(
      projectManagedAgentInteraction(
        interaction({ kind: 'question', input: {} }),
      ),
    ).toBeNull()
  })
})

describe('projectManagedAgentInteraction — plan', () => {
  it('projects a respondable plan info card (supportsResponse = true)', () => {
    const card = projectManagedAgentInteraction(
      interaction({
        kind: 'plan',
        toolName: 'ExitPlanMode',
        input: {
          toolCall: { title: 'Exit plan mode' },
          plan: '1. Do the thing',
          filePath: '/tmp/plan.md',
        },
        metadata: { callType: 'interactive', interactiveKind: 'exit-plan' },
      }),
    )
    expect(card).toMatchObject({
      kind: 'plan',
      title: 'Exit plan mode',
      plan: { content: '1. Do the thing', filePath: '/tmp/plan.md' },
      supportsResponse: true,
      actions: [],
    })
  })

  it('returns null when the plan card has nothing to show', () => {
    expect(
      projectManagedAgentInteraction(interaction({ kind: 'plan', input: {} })),
    ).toBeNull()
  })
})

describe('normalizeManagedAgentQuestions', () => {
  it('dedupes question ids and drops options without labels', () => {
    const questions = normalizeManagedAgentQuestions([
      { id: 'q', question: 'One', options: [{ label: 'A' }, { description: 'no label' }] },
      { id: 'q', question: 'Duplicate' },
      'garbage',
    ])
    expect(questions).toHaveLength(1)
    expect(questions[0]?.options).toHaveLength(1)
  })
})

describe('settleManagedAgentInteraction', () => {
  const pending = interaction({ kind: 'approval' })

  it('canonical status wins for answered/superseded', () => {
    expect(
      settleManagedAgentInteraction(
        { ...pending, status: 'answered' },
        { status: 'responding', errorMessage: null },
      ),
    ).toEqual({ state: 'answered' })
    expect(
      settleManagedAgentInteraction({ ...pending, status: 'superseded' }, null),
    ).toEqual({ state: 'superseded' })
  })

  it('maps engine response states onto pending interactions', () => {
    expect(
      settleManagedAgentInteraction(pending, { status: 'responding', errorMessage: null }),
    ).toEqual({ state: 'responding' })
    expect(
      settleManagedAgentInteraction(pending, { status: 'unknown', errorMessage: null }),
    ).toEqual({ state: 'responding' })
    expect(
      settleManagedAgentInteraction(pending, {
        status: 'failed',
        errorMessage: '  Managed Agent request failed: 409 ',
      }),
    ).toEqual({ state: 'failed', errorMessage: 'Managed Agent request failed: 409' })
    expect(settleManagedAgentInteraction(pending, null)).toEqual({ state: 'pending' })
  })
})

describe('projectPendingApprovalsFromToolCallMessages', () => {
  it('synthesizes a pending approval from waiting_approval tool_call output JSON', () => {
    const message = {
      workspaceId: 'workspace-1',
      agentSessionId: 'session-1',
      messageId: 'toolcall:6:bash',
      turnId: 'turn-1',
      role: 'assistant',
      kind: 'tool_call',
      status: 'waiting_approval',
      payload: {
        callType: 'approval',
        name: 'Approval',
        status: 'waiting_approval',
        input: {
          requestId: '0',
          options: [
            { optionId: 'approve_once', name: 'Approve once', kind: 'allow_once' },
            { optionId: 'reject', name: 'Reject', kind: 'reject_once' },
          ],
          toolCall: { title: 'Bash', toolCallId: '6:bash' },
        },
        output: { text: '{"command": "pwd"}' },
      },
      version: 1,
      sequence: 1,
      occurredAtUnixMs: 10,
    } as AgentActivityMessage

    const projected = projectPendingApprovalsFromToolCallMessages([message], [])
    expect(projected).toHaveLength(1)
    expect(projected[0]).toMatchObject({
      agentSessionId: 'session-1',
      turnId: 'turn-1',
      requestId: '0',
      kind: 'approval',
      status: 'pending',
      toolName: 'Bash',
      input: {
        requestId: '0',
        command: 'pwd',
        toolCall: {
          title: 'Bash',
          toolCallId: '6:bash',
          input: { command: 'pwd' },
        },
      },
    })
    const card = projectManagedAgentInteraction(projected[0]!)
    expect(card?.detail).toBe('pwd')
    expect(card?.actions.map((action) => action.id)).toEqual([
      'approve_once',
      'reject',
    ])
  })

  it('does not duplicate an already-pending interaction', () => {
    const message = {
      workspaceId: 'workspace-1',
      agentSessionId: 'session-1',
      messageId: 'tool-1',
      turnId: 'turn-1',
      role: 'assistant',
      kind: 'tool_call',
      status: 'waiting_approval',
      payload: {
        callType: 'approval',
        input: {
          requestId: 'request-1',
          options: [{ optionId: 'allow', name: 'Allow', kind: 'allow_once' }],
        },
      },
      version: 1,
      sequence: 1,
      occurredAtUnixMs: 1,
    } as AgentActivityMessage
    const existing = interaction({
      kind: 'approval',
      input: {
        requestId: 'request-1',
        options: [{ optionId: 'allow', name: 'Allow', kind: 'allow_once' }],
      },
    })
    expect(
      projectPendingApprovalsFromToolCallMessages([message], [existing]),
    ).toHaveLength(1)
  })
})
