import { describe, expect, it } from 'vitest'
import {
  hermesApprovalToInteraction,
  isHermesApprovalRequestEvent,
  normalizeHermesApprovalPayload,
  resolveHermesApprovalChoice,
} from './hermes-approval'
import { projectManagedAgentInteraction } from '@/screens/chat/lib/managed-agent-interactions'

describe('hermes-approval', () => {
  it('normalizes gateway approval.request payloads', () => {
    const normalized = normalizeHermesApprovalPayload({
      event: 'approval.request',
      approval_id: 'appr-1',
      run_id: 'run-9',
      command: 'rm -rf /tmp/x',
      description: 'Dangerous command',
      pattern_key: 'dangerous_command',
      choices: ['once', 'session', 'always', 'deny'],
    })
    expect(normalized).toMatchObject({
      approvalId: 'appr-1',
      runId: 'run-9',
      command: 'rm -rf /tmp/x',
      choices: ['once', 'session', 'always', 'deny'],
      rawApprovalIdPresent: true,
    })
  })

  it('projects to a ManagedAgentInteractionPanel approval card', () => {
    const normalized = normalizeHermesApprovalPayload({
      approval_id: 'appr-2',
      run_id: 'run-2',
      tool: 'terminal',
      command: 'killall scene_server',
      choices: ['once', 'deny'],
    })
    expect(normalized).not.toBeNull()
    const interaction = hermesApprovalToInteraction({
      workspaceId: 'ws',
      agentSessionId: 'sess',
      turnId: 'turn-1',
      approval: normalized!,
      nowUnixMs: 1,
    })
    const card = projectManagedAgentInteraction(interaction)
    expect(card).toMatchObject({
      kind: 'approval',
      status: 'pending',
      requestId: 'appr-2',
      detail: 'killall scene_server',
    })
    expect(card?.actions.map((action) => action.id)).toEqual(['once', 'deny'])
  })

  it('resolves managed semantic tokens to Hermes choices', () => {
    expect(resolveHermesApprovalChoice({ optionId: 'once' })).toBe('once')
    expect(resolveHermesApprovalChoice({ optionId: 'always' })).toBe('always')
    expect(resolveHermesApprovalChoice({ action: 'approve' })).toBe('once')
    expect(resolveHermesApprovalChoice({ action: 'deny' })).toBe('deny')
    expect(resolveHermesApprovalChoice({ optionId: 'nope' })).toBeNull()
  })

  it('detects approval request frames by event name or payload', () => {
    expect(
      isHermesApprovalRequestEvent('approval.request', {}),
    ).toBe(true)
    expect(
      isHermesApprovalRequestEvent('message', {
        event: 'hermes.approval.request',
      }),
    ).toBe(true)
    expect(isHermesApprovalRequestEvent('tool', {})).toBe(false)
  })
})
