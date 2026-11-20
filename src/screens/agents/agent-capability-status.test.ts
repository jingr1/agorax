import { describe, expect, it } from 'vitest'
import { agentMcpStatus } from './agent-capability-status'

describe('agent MCP connection status', () => {
  it.each([
    ['assigned', true, 'assigned'],
    ['ok', true, 'ok'],
    ['connected', true, 'ok'],
    ['error', true, 'error'],
    ['failed', true, 'error'],
    [undefined, true, 'unknown'],
    ['unrecognized', true, 'unknown'],
    ['ok', false, 'disabled'],
    ['assigned', false, 'disabled'],
  ] as const)('maps %s enabled=%s to %s', (status, enabled, expected) => {
    expect(agentMcpStatus(status, enabled)).toBe(expected)
  })
})