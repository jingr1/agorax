// @vitest-environment node
import { expect, it, vi } from 'vitest'

const calls = vi.hoisted(() => ({ start: vi.fn(), stop: vi.fn() }))
vi.mock('./collab-db', () => ({ getCollabDbPath: () => 'isolated-test', ensureCollabDb: vi.fn() }))
vi.mock('./control-plane-state', () => ({ ControlPlaneStateStore: class {} }))
vi.mock('./group-chat/runner-state', () => ({ configureRoomRunnerStateStore: vi.fn() }))
vi.mock('./group-chat/group-chat-runner', () => ({ startGroupChatRunner: calls.start, stopGroupChatRunner: calls.stop }))
vi.mock('./task-pipeline/task-scheduler', () => ({ startTaskScheduler: calls.start, stopTaskScheduler: calls.stop }))
vi.mock('./platform-skills/sync-loop', () => ({ startPlatformSkillSync: calls.start, stopPlatformSkillSync: calls.stop }))

it('starts exactly once, reports readiness and stops only owned background tasks', async () => {
  const { startControlPlane, stopControlPlane, controlPlaneReadiness } = await import('./bootstrap')
  await Promise.all([startControlPlane(), startControlPlane()])
  expect(calls.start).toHaveBeenCalledTimes(3)
  expect(controlPlaneReadiness()).toEqual({ ready: true })
  stopControlPlane()
  expect(calls.stop).toHaveBeenCalledTimes(3)
  expect(controlPlaneReadiness()).toEqual({ ready: false })
})