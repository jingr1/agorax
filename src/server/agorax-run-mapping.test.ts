import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  getAgoraxRunMappingByAgentSessionId,
  getAgoraxRunMappingByGatewaySessionId,
  patchAgoraxRunMapping,
  upsertAgoraxRunMapping,
} from './agorax-run-mapping'

describe('agorax_run_mapping', () => {
  let dbPath = ''

  beforeEach(() => {
    dbPath = path.join(
      os.tmpdir(),
      `agorax-mapping-${Date.now()}-${Math.random().toString(16).slice(2)}.db`,
    )
  })

  afterEach(() => {
    try {
      fs.unlinkSync(dbPath)
    } catch {
      // ignore
    }
  })

  it('upserts and reads by agentSessionId', () => {
    const mapping = upsertAgoraxRunMapping(
      {
        agentSessionId: 'sess-a',
        turnId: 'turn-1',
        gatewaySessionId: 'gw-1',
        assignmentId: null,
        hermesRunId: null,
        bridgeKind: 'hermes-native',
        updatedAtUnixMs: 1000,
      },
      { dbPath },
    )
    expect(mapping.agentSessionId).toBe('sess-a')
    expect(
      getAgoraxRunMappingByAgentSessionId('sess-a', { dbPath })?.gatewaySessionId,
    ).toBe('gw-1')
  })

  it('patches hermesRunId for cancel after refresh', () => {
    upsertAgoraxRunMapping(
      {
        agentSessionId: 'sess-b',
        turnId: 'turn-2',
        gatewaySessionId: 'gw-2',
        assignmentId: null,
        hermesRunId: null,
        bridgeKind: 'hermes-native',
        updatedAtUnixMs: 1000,
      },
      { dbPath },
    )
    const patched = patchAgoraxRunMapping(
      'sess-b',
      { hermesRunId: 'run-99' },
      { dbPath },
    )
    expect(patched?.hermesRunId).toBe('run-99')
    expect(
      getAgoraxRunMappingByGatewaySessionId('gw-2', { dbPath })?.hermesRunId,
    ).toBe('run-99')
  })
})
