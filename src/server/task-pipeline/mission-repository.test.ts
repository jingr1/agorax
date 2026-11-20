// @vitest-environment node
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'

const root = mkdtempSync(join(tmpdir(), 'mission-repository-'))
vi.mock('../swarm-environment', () => ({ get SWARM_MISSIONS_PATH() { return join(root, 'export.json') } }))
afterEach(() => rmSync(root, { recursive: true, force: true }))

it('does not export on writes and explicitly exports every mission beyond the page cap', async () => {
  const { SqliteMissionRepository } = await import('./mission-repository')
  const repository = new SqliteMissionRepository(join(root, 'collab.db'))
  for (let index = 0; index < 105; index++) {
    repository.createOrUpdateMission({ missionId: `mission-${index}`, title: `Mission ${index}`, spec: 'Large specification', assignments: [{ workerId: 'developer', task: 'Build' }] })
  }
  expect(existsSync(join(root, 'export.json'))).toBe(false)
  expect(repository.listMissions(1000)).toHaveLength(100)
  const summaries = repository.listMissions(100, 0, { summaryOnly: true })
  expect(summaries).toHaveLength(100)
  expect(summaries[0].events).toEqual([])
  expect(summaries[0].assignments).toHaveLength(1)
  expect(repository.exportToJson()).toHaveLength(105)
  expect(existsSync(join(root, 'export.json'))).toBe(true)
})