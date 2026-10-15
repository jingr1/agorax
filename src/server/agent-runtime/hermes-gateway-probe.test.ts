import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../gateway-pool', () => ({
  probeProfileGateway: vi.fn(),
}))

vi.mock('../gateway-ports', () => ({
  getProfileGatewayUrl: vi.fn((name: string) => `http://127.0.0.1:86${name}`),
  resolveProfileGatewayPort: vi.fn(() => 8642),
}))

vi.mock('../gateway-port-owner', () => ({
  isPortInUse: vi.fn(),
}))

import { probeProfileGateway } from '../gateway-pool'
import { isPortInUse } from '../gateway-port-owner'
import { getProfileGatewayUrl } from '../gateway-ports'
import {
  clearHermesGatewayProbeCache,
  probeHermesProfileGateway,
} from './hermes-gateway-probe'

describe('probeHermesProfileGateway', () => {
  beforeEach(() => {
    clearHermesGatewayProbeCache()
    vi.mocked(probeProfileGateway).mockReset()
    vi.mocked(isPortInUse).mockReset()
    vi.mocked(getProfileGatewayUrl).mockImplementation(
      (name: string) => `http://127.0.0.1:8642/${name}`,
    )
  })

  afterEach(() => {
    clearHermesGatewayProbeCache()
  })

  it('is available when the profile owns its gateway port', async () => {
    vi.mocked(probeProfileGateway).mockResolvedValue(true)

    await expect(probeHermesProfileGateway('orchestrator')).resolves.toEqual({
      available: true,
      detail: 'hermes gateway http://127.0.0.1:8642/orchestrator',
    })
    expect(isPortInUse).not.toHaveBeenCalled()
  })

  it('reports not running when nothing listens', async () => {
    vi.mocked(probeProfileGateway).mockResolvedValue(false)
    vi.mocked(isPortInUse).mockReturnValue(false)

    await expect(probeHermesProfileGateway('writer')).resolves.toEqual({
      available: false,
      detail: 'hermes gateway not running (http://127.0.0.1:8642/writer)',
    })
  })

  it('reports port not owned when something else listens', async () => {
    vi.mocked(probeProfileGateway).mockResolvedValue(false)
    vi.mocked(isPortInUse).mockReturnValue(true)

    await expect(probeHermesProfileGateway('default')).resolves.toEqual({
      available: false,
      detail: 'hermes gateway port not owned (http://127.0.0.1:8642/default)',
    })
  })

  it('caches positive results longer than negatives', async () => {
    vi.mocked(probeProfileGateway).mockResolvedValue(true)
    await probeHermesProfileGateway('aider')
    expect(probeProfileGateway).toHaveBeenCalledTimes(1)

    await probeHermesProfileGateway('aider')
    expect(probeProfileGateway).toHaveBeenCalledTimes(1)

    clearHermesGatewayProbeCache()
    vi.mocked(probeProfileGateway).mockResolvedValue(false)
    vi.mocked(isPortInUse).mockReturnValue(false)
    await probeHermesProfileGateway('aider')
    expect(probeProfileGateway).toHaveBeenCalledTimes(2)

    await probeHermesProfileGateway('aider')
    // Negative TTL is short but still covers back-to-back list polls.
    expect(probeProfileGateway).toHaveBeenCalledTimes(2)
  })
})
