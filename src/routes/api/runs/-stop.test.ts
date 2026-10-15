import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../../../server/auth-middleware', () => ({
  isAuthenticated: vi.fn(),
}))
vi.mock('../../../server/rate-limit', () => ({
  requireJsonContentType: vi.fn(() => null),
}))
vi.mock('../../../server/hermes-api', () => ({
  stopRun: vi.fn(),
}))
vi.mock('../../../server/run-store', () => ({
  markRunStatus: vi.fn(),
}))
vi.mock('../../../server/stream-handoff-registry', () => ({
  clearRunDetached: vi.fn(),
}))
vi.mock('../../../server/send-run-tracker', () => ({
  getActiveSendRunHandle: vi.fn(),
  interruptActiveSendRun: vi.fn(),
  interruptActiveSendRunsForSession: vi.fn(),
}))

import { isAuthenticated } from '../../../server/auth-middleware'
import { stopRun as stopHermesRun } from '../../../server/hermes-api'
import { markRunStatus } from '../../../server/run-store'
import { clearRunDetached } from '../../../server/stream-handoff-registry'
import {
  getActiveSendRunHandle,
  interruptActiveSendRun,
  interruptActiveSendRunsForSession,
} from '../../../server/send-run-tracker'
import { Route as StopRoute } from './$runId.stop'

const mockIsAuthenticated = vi.mocked(isAuthenticated)
const mockClearRunDetached = vi.mocked(clearRunDetached)
const mockInterruptRun = vi.mocked(interruptActiveSendRun)
const mockInterruptSession = vi.mocked(interruptActiveSendRunsForSession)
const mockGetHandle = vi.mocked(getActiveSendRunHandle)
const mockMarkRunStatus = vi.mocked(markRunStatus)
const mockStopHermesRun = vi.mocked(stopHermesRun)

function makeRequest(body: unknown): Request {
  return new Request('http://localhost/api/runs/run-1/stop', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
}

async function callPost(
  request: Request,
  runId = 'run-1',
): Promise<Response> {
  const handlers = StopRoute.options.server?.handlers as Record<
    string,
    (ctx: {
      request: Request
      params: { runId: string }
    }) => Promise<Response>
  >
  return handlers['POST']({ request, params: { runId } })
}

beforeEach(() => {
  vi.clearAllMocks()
  mockIsAuthenticated.mockReturnValue(true)
  mockGetHandle.mockReturnValue(null)
  mockInterruptRun.mockReturnValue(true)
  mockInterruptSession.mockReturnValue(['run-1', 'run-2'])
  mockMarkRunStatus.mockResolvedValue(undefined as never)
  mockStopHermesRun.mockRejectedValue(new Error('not a durable run'))
})

describe('POST /api/runs/:runId/stop', () => {
  it('returns 401 when not authenticated', async () => {
    mockIsAuthenticated.mockReturnValue(false)
    const res = await callPost(makeRequest({ sessionKey: 's1' }))
    expect(res.status).toBe(401)
    expect(mockInterruptRun).not.toHaveBeenCalled()
  })

  it('aborts the live send-stream handle and sibling session runs', async () => {
    const res = await callPost(makeRequest({ sessionKey: 'session-a' }))
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.ok).toBe(true)
    expect(body.interrupted).toBe(true)
    expect(body.interruptedRunIds).toEqual(['run-1', 'run-2'])
    expect(mockClearRunDetached).toHaveBeenCalledWith('run-1')
    expect(mockInterruptRun).toHaveBeenCalledWith('run-1')
    expect(mockInterruptSession).toHaveBeenCalledWith('session-a')
    expect(mockMarkRunStatus).toHaveBeenCalled()
  })

  it('uses the live handle session when body omits sessionKey', async () => {
    mockGetHandle.mockReturnValue({
      runId: 'run-1',
      sessionKey: 'session-from-handle',
      abortUpstream: () => {},
    })
    mockInterruptSession.mockReturnValue(['run-1'])
    const res = await callPost(makeRequest({}))
    expect(res.status).toBe(200)
    expect(mockInterruptSession).toHaveBeenCalledWith('session-from-handle')
  })
})
