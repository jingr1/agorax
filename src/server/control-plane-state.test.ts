// @vitest-environment node
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { ControlPlaneStateStore } from './control-plane-state'
import {
  bumpRoomEpoch, clearAllRunnerState, configureRoomRunnerStateStore,
  expireStaleInFlight, getInFlightMembers, getRoomEpoch, getRoomHolds,
  getStranded, setRoomHolds, setStranded, setTurnInFlight,
  updateTurnInFlight,
} from './group-chat/runner-state'
import type { GroupMember } from './group-chat/types'

const roots: Array<string> = []
afterEach(() => { clearAllRunnerState(); for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })

it('preserves control intent and retry deadlines across store recreation', () => {
  const root = mkdtempSync(join(tmpdir(), 'control-state-')); roots.push(root)
  const first = new ControlPlaneStateStore(join(root, 'state.db'))
  first.write('room', 'r1', { holds: { developer: true }, epoch: 4 })
  first.write('retry', 'a1', { dueAtMs: 12345, attempt: 2 })
  const restarted = new ControlPlaneStateStore(first.dbPath)
  expect(restarted.read('room', 'r1')).toEqual({ holds: { developer: true }, epoch: 4 })
  expect(restarted.read('retry', 'a1')).toEqual({ dueAtMs: 12345, attempt: 2 })
})

it('fences duplicate claims and does not treat expiry as proof that execution ended', () => {
  const root = mkdtempSync(join(tmpdir(), 'control-lease-')); roots.push(root)
  const first = new ControlPlaneStateStore(join(root, 'state.db'))
  const second = new ControlPlaneStateStore(first.dbPath)
  const input = { namespace: 'dispatch', key: 'a1', groupId: 'm1', owner: 'first', globalLimit: 2, groupLimit: 1, ttlMs: 1000, now: 1000 }
  const lease = first.claim(input)!
  expect(second.claim({ ...input, owner: 'second', now: 4000 })).toBeNull()
  expect(first.owns(lease, 1500)).toBe(true)
  expect(first.owns(lease, 4000)).toBe(false)
  expect(second.claim({ ...input, key: 'a2' })).toBeNull()
  first.reconcileTerminal('dispatch', 'a1')
  const next = second.claim({ ...input, owner: 'second', now: 4000 })!
  first.release(lease)
  expect(second.owns(next, 4500)).toBe(true)
})

it('restores member stop intent, epoch and unresolved turns without redispatch', () => {
  const root = mkdtempSync(join(tmpdir(), 'room-restart-')); roots.push(root)
  const store = new ControlPlaneStateStore(join(root, 'state.db'))
  const member = { participantId: 'developer', runtime: 'hermes', profile: 'developer' } as GroupMember
  configureRoomRunnerStateStore(store)
  const holds = { developer: { at: 123, byMessageId: 'stop-1' } }
  setRoomHolds('room-1', holds)
  bumpRoomEpoch('room-1')
  expect(setTurnInFlight('room-1', member, 'session-1')).toBe(true)
  updateTurnInFlight('room-1', member, { before: 4, runId: 'managed-run-1' })
  setStranded('room-1', member, { before: 4, sessionId: 'session-1' })
  clearAllRunnerState()
  configureRoomRunnerStateStore(new ControlPlaneStateStore(store.dbPath))
  expect(getRoomHolds('room-1')).toEqual(holds)
  expect(getRoomEpoch('room-1')).toBe(1)
  expect(getInFlightMembers('room-1')).toHaveLength(1)
  expect(getStranded('room-1', member)?.sessionId).toBe('session-1')
  expect(expireStaleInFlight('room-1', -1)).toEqual([])
  expect(setTurnInFlight('room-1', member, 'duplicate')).toBe(false)
})