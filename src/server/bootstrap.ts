import { ensureCollabDb, getCollabDbPath } from './collab-db'
import { ControlPlaneStateStore } from './control-plane-state'
import { configureRoomRunnerStateStore } from './group-chat/runner-state'
import { startGroupChatRunner, stopGroupChatRunner } from './group-chat/group-chat-runner'
import { startTaskScheduler, stopTaskScheduler } from './task-pipeline/task-scheduler'
import { startPlatformSkillSync, stopPlatformSkillSync } from './platform-skills/sync-loop'

let initialization: Promise<void> | null = null
let ready = false

export function startControlPlane(): Promise<void> {
  if (initialization) return initialization
  initialization = Promise.resolve().then(() => {
    ensureCollabDb()
    const store = new ControlPlaneStateStore(getCollabDbPath())
    configureRoomRunnerStateStore(store)
    startTaskScheduler(store)
    startGroupChatRunner()
    startPlatformSkillSync()
    ready = true
  }).catch((error) => {
    stopControlPlane()
    throw error
  })
  return initialization
}

export function stopControlPlane(): void {
  stopPlatformSkillSync()
  stopGroupChatRunner()
  stopTaskScheduler()
  ready = false
  initialization = null
}

export function controlPlaneReadiness(): { ready: boolean } {
  return { ready }
}

if (import.meta.hot) import.meta.hot.dispose(stopControlPlane)