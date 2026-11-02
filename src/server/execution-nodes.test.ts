// @vitest-environment node
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  deleteExecutionNode,
  getExecutionNode,
  heartbeatExecutionNode,
  listExecutionNodes,
  markStaleExecutionNodesOffline,
  upsertExecutionNode,
} from './execution-nodes'

describe('execution node registry', () => {
  let root: string
  let dbPath: string

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'agorax-execution-nodes-'))
    dbPath = join(root, 'collab.db')
  })

  afterEach(() => rmSync(root, { recursive: true, force: true }))

  it('persists and updates a node heartbeat', () => {
    const created = upsertExecutionNode(
      {
        id: 'builder-1',
        name: 'Builder workstation',
        baseUrl: 'https://node.example:8788/',
        workspaceId: 'team',
        capabilities: ['codex', 'claude-code', 'codex'],
      },
      dbPath,
    )

    expect(created.baseUrl).toBe('https://node.example:8788')
    expect(created.capabilities).toEqual(['claude-code', 'codex'])
    expect(listExecutionNodes(dbPath)).toHaveLength(1)

    const heartbeat = heartbeatExecutionNode('builder-1', ['codex'], dbPath)
    expect(heartbeat?.status).toBe('online')
    expect(heartbeat?.capabilities).toEqual(['codex'])
  })

  it('marks stale nodes offline and supports removal', () => {
    upsertExecutionNode(
      { id: 'reviewer-1', name: 'Reviewer', baseUrl: 'https://node.example' },
      dbPath,
    )
    expect(markStaleExecutionNodesOffline(Date.now() + 1, dbPath)).toBe(1)
    expect(getExecutionNode('reviewer-1', dbPath)?.status).toBe('offline')
    expect(deleteExecutionNode('reviewer-1', dbPath)).toBe(true)
    expect(getExecutionNode('reviewer-1', dbPath)).toBeNull()
  })

  it('rejects endpoint credentials', () => {
    expect(() =>
      upsertExecutionNode(
        {
          id: 'bad-node',
          name: 'Bad node',
          baseUrl: 'https://user:secret@example.com',
        },
        dbPath,
      ),
    ).toThrow('must not contain credentials')
  })
})
