import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../../../server/auth-middleware', () => ({
  isAuthenticated: vi.fn(),
}))
vi.mock('../../../server/run-store', () => ({
  markRunStatus: vi.fn(),
}))
vi.mock('../../../server/stream-handoff-registry', () => ({
  markRunDetached: vi.fn(),
}))

import { isAuthenticated } from '../../../server/auth-middleware'
import { markRunStatus } from '../../../server/run-store'
import { markRunDetached } from '../../../server/stream-handoff-registry'
import { Route as DetachRoute } from './detach'

const mockIsAuthenticated = vi.mocked(isAuthenticated)
const mockMarkRunStatus = vi.mocked(markRunStatus)
const mockMarkRunDetached = vi.mocked(markRunDetached)

function makeRequest(body: unknown): Request {
  return new Request('http://localhost/api/runs/detach', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
}

async function callPost(request: Request): Promise<Response> {
  const handlers = DetachRoute.options.server?.handlers as Record<
    string,
    (ctx: { request: Request }) => Promise<Response>
  >
  return handlers['POST']({ request })
}

beforeEach(() => {
  vi.clearAllMocks()
  mockIsAuthenticated.mockReturnValue(true)
  mockMarkRunStatus.mockResolvedValue(undefined)
})

describe('POST /api/runs/detach', () => {
  it('returns 401 when not authenticated', async () => {
    mockIsAuthenticated.mockReturnValue(false)
    const res = await callPost(makeRequest({ runId: 'r1', sessionKey: 's1' }))
    expect(res.status).toBe(401)
    expect(mockMarkRunDetached).not.toHaveBeenCalled()
  })

  it('returns 400 when runId or sessionKey is missing', async () => {
    const res = await callPost(makeRequest({ runId: 'r1' }))
    expect(res.status).toBe(400)
    expect(mockMarkRunDetached).not.toHaveBeenCalled()
  })

  it('marks run detached and persists handoff status', async () => {
    const res = await callPost(
      makeRequest({
        runId: ' run-abc ',
        sessionKey: ' session-1 ',
        profileName: ' developer ',
      }),
    )
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body).toEqual({
      ok: true,
      runId: 'run-abc',
      sessionKey: 'session-1',
      profileName: 'developer',
    })
    expect(mockMarkRunDetached).toHaveBeenCalledWith('run-abc')
    expect(mockMarkRunStatus).toHaveBeenCalledWith(
      'session-1',
      'run-abc',
      'handoff',
    )
  })

  it('still returns ok when run file update fails', async () => {
    mockMarkRunStatus.mockRejectedValue(new Error('missing run file'))
    const res = await callPost(
      makeRequest({ runId: 'run-x', sessionKey: 'session-x' }),
    )
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.ok).toBe(true)
    expect(mockMarkRunDetached).toHaveBeenCalledWith('run-x')
  })
})
