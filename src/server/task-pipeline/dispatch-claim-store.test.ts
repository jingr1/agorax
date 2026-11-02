// @vitest-environment node
import { spawn } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  acquireDispatchClaim,
  ownsDispatchClaim,
  releaseDispatchClaim,
  renewDispatchClaim,
} from './dispatch-claim-store'

describe('dispatch claim store', () => {
  let root: string
  let dbPath: string

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'agorax-dispatch-claim-'))
    dbPath = join(root, 'collab.db')
  })

  afterEach(() => rmSync(root, { recursive: true, force: true }))

  it('allows only one owner during an active lease', () => {
    const first = acquireDispatchClaim(
      { missionId: 'm1', assignmentId: 'a1', ownerId: 'server-1', nowMs: 100 },
      dbPath,
    )
    expect(first?.attempt).toBe(1)
    expect(
      acquireDispatchClaim(
        {
          missionId: 'm1',
          assignmentId: 'a1',
          ownerId: 'server-2',
          nowMs: 101,
        },
        dbPath,
      ),
    ).toBeNull()
  })

  it('fences an old owner after lease takeover', () => {
    const first = acquireDispatchClaim(
      {
        missionId: 'm1',
        assignmentId: 'a1',
        ownerId: 'server-1',
        nowMs: 100,
        leaseMs: 10,
      },
      dbPath,
    )!
    const second = acquireDispatchClaim(
      { missionId: 'm1', assignmentId: 'a1', ownerId: 'server-2', nowMs: 111 },
      dbPath,
    )!
    expect(second.attempt).toBe(2)
    expect(ownsDispatchClaim(first, dbPath, 112)).toBe(false)
    expect(ownsDispatchClaim(second, dbPath, 112)).toBe(true)
    expect(releaseDispatchClaim(first, false, dbPath)).toBe(false)
  })

  it('renews and releases the exact attempt', () => {
    const claim = acquireDispatchClaim(
      { missionId: 'm1', assignmentId: 'a1', ownerId: 'server-1', nowMs: 100 },
      dbPath,
    )!
    const renewed = renewDispatchClaim(claim, 'running', dbPath, 200, 500)
    expect(renewed?.leaseExpiresAt).toBe(700)
    expect(releaseDispatchClaim(renewed!, false, dbPath)).toBe(true)
    expect(
      acquireDispatchClaim(
        {
          missionId: 'm1',
          assignmentId: 'a1',
          ownerId: 'server-2',
          nowMs: 201,
        },
        dbPath,
      )?.attempt,
    ).toBe(2)
  })

  it('serializes first-open migration and claim across processes', async () => {
    const raceDbPath = join(root, 'claim-race.db')
    const code = `
        import { acquireDispatchClaim } from './src/server/task-pipeline/dispatch-claim-store.ts';
        const claim = acquireDispatchClaim(
          { missionId: 'm-race', assignmentId: 'a-race', ownerId: process.env.CLAIM_OWNER },
          ${JSON.stringify(raceDbPath)},
        );
        console.log(JSON.stringify(claim));
      `
    const run = (ownerId: string): Promise<string> =>
      new Promise((resolve, reject) => {
        const child = spawn('pnpm', ['exec', 'tsx', '-e', code], {
          cwd: process.cwd(),
          env: { ...process.env, CLAIM_OWNER: ownerId },
        })
        let stdout = ''
        let stderr = ''
        child.stdout.on('data', (chunk) => (stdout += String(chunk)))
        child.stderr.on('data', (chunk) => (stderr += String(chunk)))
        child.on('error', reject)
        child.on('exit', (exitCode) => {
          if (exitCode !== 0) {
            reject(new Error(stderr || `claim child exited ${exitCode}`))
            return
          }
          resolve(stdout.trim().split('\n').at(-1) ?? '')
        })
      })

    const results = await Promise.all([run('scheduler-a'), run('scheduler-b')])
    const winners = results.filter((result) => result !== 'null')
    expect(winners).toHaveLength(1)
    expect(JSON.parse(winners[0])).toMatchObject({ attempt: 1 })
  }, 20_000)
})
