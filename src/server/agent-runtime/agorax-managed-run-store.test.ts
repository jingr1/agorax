import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { AgoraxManagedRunStore } from './agorax-managed-run-store'

const temporaryRoots: string[] = []

afterEach(async () => {
  await Promise.all(
    temporaryRoots.splice(0).map((root) =>
      rm(root, { recursive: true, force: true }),
    ),
  )
})

describe('AgoraxManagedRunStore', () => {
  it('persists only the run-to-canonical identity binding', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'agorax-managed-run-'))
    temporaryRoots.push(root)
    const store = new AgoraxManagedRunStore(root)

    await store.bind({
      runId: 'run/1',
      backend: 'cursor',
      agentSessionId: 'session-1',
      turnId: 'turn-1',
    })

    await expect(store.get('run/1')).resolves.toMatchObject({
      runId: 'run/1',
      backend: 'cursor',
      agentSessionId: 'session-1',
      turnId: 'turn-1',
    })
  })

  it('returns null for an unknown run', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'agorax-managed-run-'))
    temporaryRoots.push(root)
    await expect(new AgoraxManagedRunStore(root).get('missing')).resolves.toBeNull()
  })
})