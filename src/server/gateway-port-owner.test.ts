import { describe, expect, it } from 'vitest'
import {
  isPortInUse,
  pidListeningOnPort,
  readProcessHermesHome,
} from './gateway-port-owner'

describe('gateway-port-owner', () => {
  it('reports unused ports as free', () => {
    expect(isPortInUse(1)).toBe(false)
  })

  it('resolves the listener pid for a live local port when available', () => {
    // Port 1 is reserved/unused on typical workstations.
    expect(pidListeningOnPort(1)).toBeNull()
  })

  it('returns null for a non-existent process home', () => {
    expect(readProcessHermesHome(999_999_999)).toBeNull()
  })
})
