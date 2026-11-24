import * as fs from 'node:fs'
import * as path from 'node:path'
import { ensureCollabDb, getCollabDbPath } from '../collab-db'
import { openSqliteDatabase } from '../sqlite-helper'
import {
  getPlatformSkill,
  listPlatformSkills,
  pruneExcludedPlatformSkillFiles,
} from './store'
import {
  PLATFORM_MARKER,
  SKILL_TREE_EXCLUDED_DIR_NAMES,
} from './skill-tree'
import { skillWorkingDirectory } from './deployment-tree'
import { reconcilePlatformSkill } from './reconcile'
import { platformSkillTarget } from './runtime-target'

export const SKILL_SYNC_DEBOUNCE_MS = 500
export const SKILL_SYNC_FALLBACK_MS = 30_000
export const SKILL_SYNC_IDLE_GAP_MS = 50

type WatchDirectory = (
  directory: string,
  changed: (filename?: string) => void,
  failed: (error: unknown) => void,
) => { close: () => void }

type SkillWatchTarget = {
  revisionId: string
  directories: Array<string>
}

function watchDirectory(
  directory: string,
  changed: (filename?: string) => void,
  failed: (error: unknown) => void,
) {
  const watcher = fs.watch(
    directory,
    { recursive: true, persistent: false, encoding: 'utf8' },
    (_event, filename) => changed(filename ?? undefined),
  )
  watcher.on('error', failed)
  return watcher
}

/** One readonly SQLite pass — avoids hundreds of connect/query round-trips. */
function loadWatchTargets(): Map<string, SkillWatchTarget> {
  ensureCollabDb()
  const db = openSqliteDatabase(getCollabDbPath(), true)
  try {
    const skills = db
      .prepare('SELECT id, name, revision_id FROM platform_skills')
      .all() as Array<{ id: unknown; name: unknown; revision_id: unknown }>
    const deployments = db
      .prepare(
        'SELECT skill_id, path FROM skill_deployments WHERE path IS NOT NULL',
      )
      .all() as Array<{ skill_id: unknown; path: unknown }>
    const bindings = db
      .prepare('SELECT skill_id, agent_id FROM agent_skills')
      .all() as Array<{ skill_id: unknown; agent_id: unknown }>
    const bySkill = new Map<string, SkillWatchTarget>()
    for (const row of skills) {
      const id = String(row.id)
      bySkill.set(id, {
        revisionId: String(row.revision_id ?? ''),
        directories: [skillWorkingDirectory(id)],
      })
    }
    for (const row of deployments) {
      const target = bySkill.get(String(row.skill_id))
      const directory = String(row.path ?? '')
      if (target && directory) target.directories.push(directory)
    }
    const names = new Map(
      skills.map((row) => [String(row.id), String(row.name)] as const),
    )
    const rootsByAgent = new Map<string, string | undefined>()
    for (const row of bindings) {
      const skillId = String(row.skill_id)
      const target = bySkill.get(skillId)
      const name = names.get(skillId)
      if (!target || !name) continue
      const agentId = String(row.agent_id)
      if (!rootsByAgent.has(agentId))
        rootsByAgent.set(agentId, platformSkillTarget(agentId).root)
      const root = rootsByAgent.get(agentId)
      if (root) target.directories.push(path.join(root, name))
    }
    for (const target of bySkill.values()) {
      target.directories = [...new Set(target.directories)]
    }
    return bySkill
  } finally {
    db.close()
  }
}

function fingerprintDirectory(directory: string): string {
  try {
    const stat = fs.lstatSync(directory)
    if (stat.isSymbolicLink()) return `link:${fs.readlinkSync(directory)}`
    if (!stat.isDirectory()) return `node:${stat.mtimeMs}:${stat.size}`
    // Category folders and other unmanaged trees: metadata only, no deep walk.
    if (!fs.existsSync(path.join(directory, 'SKILL.md')))
      return `dir:${stat.mtimeMs}:${stat.ino}:noskill`
    const parts: Array<string> = []
    let files = 0
    const walk = (current: string, prefix: string) => {
      for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
        if (
          entry.name === PLATFORM_MARKER ||
          entry.name.endsWith('.pyc') ||
          SKILL_TREE_EXCLUDED_DIR_NAMES.has(entry.name)
        ) {
          if (entry.name === PLATFORM_MARKER) {
            try {
              const marker = fs.lstatSync(path.join(current, entry.name))
              parts.push(
                `${prefix}${PLATFORM_MARKER}:${marker.mtimeMs}:${marker.size}`,
              )
            } catch {
              /* ignore */
            }
          }
          continue
        }
        const relative = prefix ? `${prefix}/${entry.name}` : entry.name
        const full = path.join(current, entry.name)
        if (entry.isSymbolicLink()) {
          parts.push(`${relative}:link:${fs.readlinkSync(full)}`)
          continue
        }
        if (entry.isDirectory()) {
          walk(full, relative)
          continue
        }
        if (!entry.isFile()) continue
        files += 1
        if (files > 512)
          throw new Error(
            `Skill package exceeds file or size limits (${files} files; max 512): ${directory}`,
          )
        const file = fs.lstatSync(full)
        parts.push(`${relative}:${file.mtimeMs}:${file.size}`)
      }
    }
    walk(directory, '')
    parts.sort()
    return parts.join('|')
  } catch (error) {
    return `error:${error instanceof Error ? error.message : String(error)}`
  }
}

function fingerprintForSkill(
  skillId: string,
  directories: Array<string>,
  revisionId: string,
): string {
  return JSON.stringify([
    revisionId,
    [...directories]
      .sort()
      .map((directory) => [directory, fingerprintDirectory(directory)]),
  ])
}

function watchAncestor(directory: string): string {
  let ancestor = path.dirname(directory)
  while (!fs.existsSync(ancestor) || !fs.lstatSync(ancestor).isDirectory()) {
    const parent = path.dirname(ancestor)
    if (parent === ancestor)
      throw new Error('No accessible skill watch directory')
    ancestor = parent
  }
  return ancestor
}

function watchIdentity(directory: string): string {
  try {
    const stat = fs.statSync(directory)
    return JSON.stringify([stat.dev, stat.ino, stat.birthtimeMs])
  } catch {
    return 'missing'
  }
}

export function createPlatformSkillSync(input?: {
  watchDirectory?: WatchDirectory
  debounceMs?: number
  fallbackMs?: number
  idleGapMs?: number
}) {
  const observations = new Map<
    string,
    { fingerprint: string; applied?: string }
  >()
  const pending = new Map<string, ReturnType<typeof setTimeout>>()
  const watchers = new Map<string, { close: () => void; identity: string }>()
  const failedRoots = new Map<string, number>()
  const layouts = new Map<string, string>()
  const warned = new Map<string, string>()
  const idleQueue: Array<string> = []
  const idleQueued = new Set<string>()
  let targets = new Map<string, Array<string>>()
  let revisions = new Map<string, string>()
  let refreshTimer: ReturnType<typeof setInterval> | undefined
  let fallbackTimer: ReturnType<typeof setInterval> | undefined
  let idleTimer: ReturnType<typeof setTimeout> | undefined
  let bootTimer: ReturnType<typeof setTimeout> | undefined
  let running = false
  const warn = (error: unknown, key = '') => {
    const message = error instanceof Error ? error.message : String(error)
    if (key && warned.get(key) === message) return
    if (key) warned.set(key, message)
    console.warn('[platform-skills] watcher/sync:', message)
  }

  const enqueue = (
    skillId: string,
    delay = input?.debounceMs ?? SKILL_SYNC_DEBOUNCE_MS,
  ) => {
    if (!running) return
    const timer = pending.get(skillId)
    if (timer) clearTimeout(timer)
    const next = setTimeout(() => {
      pending.delete(skillId)
      try {
        if (!checkSkill(skillId)) enqueue(skillId, 100)
      } catch (error) {
        warn(error, skillId)
        enqueue(skillId, input?.fallbackMs ?? SKILL_SYNC_FALLBACK_MS)
      }
    }, delay)
    next.unref()
    pending.set(skillId, next)
  }

  const pumpIdle = () => {
    if (!running || idleTimer || idleQueue.length === 0) return
    idleTimer = setTimeout(() => {
      idleTimer = undefined
      const skillId = idleQueue.shift()
      if (!skillId) return
      idleQueued.delete(skillId)
      try {
        if (!checkSkill(skillId)) enqueue(skillId, 100)
      } catch (error) {
        warn(error, skillId)
      }
      pumpIdle()
    }, input?.idleGapMs ?? SKILL_SYNC_IDLE_GAP_MS)
    idleTimer.unref()
  }

  const scheduleIdle = (skillId: string) => {
    if (!running || idleQueued.has(skillId)) return
    idleQueued.add(skillId)
    idleQueue.push(skillId)
    pumpIdle()
  }

  const checkSkill = (skillId: string): boolean => {
    if (!getPlatformSkill(skillId)) {
      observations.delete(skillId)
      warned.delete(skillId)
      return true
    }
    const directories =
      targets.get(skillId) ??
      loadWatchTargets().get(skillId)?.directories ??
      []
    const revisionId =
      revisions.get(skillId) ??
      getPlatformSkill(skillId)?.revisionId ??
      ''
    const fingerprint = fingerprintForSkill(skillId, directories, revisionId)
    const previous = observations.get(skillId)
    if (previous?.fingerprint !== fingerprint) {
      observations.set(skillId, { fingerprint, applied: previous?.applied })
      warned.delete(skillId)
      return false
    }
    if (previous.applied === fingerprint) return true
    const results = reconcilePlatformSkill(skillId)
    const after = fingerprintForSkill(
      skillId,
      targets.get(skillId) ?? directories,
      revisions.get(skillId) ?? revisionId,
    )
    const settled = after === fingerprint
    observations.set(skillId, {
      fingerprint: after,
      applied: settled ? after : undefined,
    })
    if (!settled) return false
    if (results.some((result) => result.status === 'pending')) {
      enqueue(skillId, input?.fallbackMs ?? SKILL_SYNC_FALLBACK_MS)
    } else if (results.some((result) => result.status === 'error')) {
      const message = [
        ...new Set(
          results
            .filter((result) => result.status === 'error')
            .map((result) => result.message)
            .filter((entry): entry is string => Boolean(entry)),
        ),
      ].join('; ')
      if (message) warn(message, skillId)
    }
    return true
  }

  const check = () => {
    const snapshot = loadWatchTargets()
    for (const [skillId, target] of snapshot) {
      targets.set(skillId, target.directories)
      revisions.set(skillId, target.revisionId)
    }
    for (const skillId of snapshot.keys()) {
      try {
        if (!checkSkill(skillId)) enqueue(skillId, 100)
      } catch (error) {
        warn(error, skillId)
      }
    }
  }

  const refresh = (mode: 'boot' | 'watch' | 'fallback' = 'watch') => {
    const snapshot = loadWatchTargets()
    const next = new Map<string, Array<string>>()
    const nextRevisions = new Map<string, string>()
    const roots = new Set<string>()
    for (const [skillId, target] of snapshot) {
      next.set(skillId, target.directories)
      nextRevisions.set(skillId, target.revisionId)
      for (const directory of target.directories) {
        try {
          roots.add(watchAncestor(directory))
        } catch (error) {
          warn(error)
        }
      }
      const layout = JSON.stringify([
        target.revisionId,
        target.directories.map((directory) => [
          directory,
          watchIdentity(directory),
        ]),
      ])
      const layoutChanged = layouts.get(skillId) !== layout
      layouts.set(skillId, layout)
      if (mode === 'boot' || mode === 'fallback') scheduleIdle(skillId)
      else if (layoutChanged) enqueue(skillId)
    }
    targets = next
    revisions = nextRevisions
    for (const skillId of layouts.keys())
      if (!targets.has(skillId)) layouts.delete(skillId)
    for (const [root, watcher] of watchers) {
      if (!roots.has(root) || watcher.identity !== watchIdentity(root)) {
        watcher.close()
        watchers.delete(root)
      }
    }
    for (const root of roots) {
      const failedAt = failedRoots.get(root)
      if (
        watchers.has(root) ||
        (failedAt !== undefined &&
          Date.now() - failedAt < SKILL_SYNC_FALLBACK_MS)
      )
        continue
      try {
        const watcher = (input?.watchDirectory ?? watchDirectory)(
          root,
          (filename) => {
            const changed =
              filename === undefined ? undefined : path.resolve(root, filename)
            for (const [skillId, directories] of targets) {
              if (
                !changed ||
                directories.some(
                  (directory) =>
                    changed === directory ||
                    changed.startsWith(`${directory}${path.sep}`) ||
                    directory.startsWith(`${changed}${path.sep}`),
                )
              )
                enqueue(skillId)
            }
          },
          (error) => {
            watchers.get(root)?.close()
            watchers.delete(root)
            failedRoots.set(root, Date.now())
            warn(error)
          },
        )
        watchers.set(root, {
          close: () => watcher.close(),
          identity: watchIdentity(root),
        })
        failedRoots.delete(root)
      } catch (error) {
        failedRoots.set(root, Date.now())
        warn(error)
      }
    }
  }

  const start = () => {
    if (running) return
    running = true
    // Keep control-plane startup non-blocking: Vite awaits startControlPlane.
    bootTimer = setTimeout(() => {
      bootTimer = undefined
      if (!running) return
      try {
        const removed = pruneExcludedPlatformSkillFiles()
        if (removed > 0)
          console.info(
            `[platform-skills] pruned ${removed} excluded catalog attachment(s)`,
          )
        refresh('boot')
      } catch (error) {
        warn(error)
      }
    }, 0)
    bootTimer.unref()
    refreshTimer = setInterval(() => {
      try {
        refresh('watch')
      } catch (error) {
        warn(error)
      }
    }, 3_000)
    fallbackTimer = setInterval(() => {
      try {
        refresh('fallback')
      } catch (error) {
        warn(error)
      }
    }, input?.fallbackMs ?? SKILL_SYNC_FALLBACK_MS)
    refreshTimer.unref()
    fallbackTimer.unref()
  }

  const stop = () => {
    running = false
    if (bootTimer) clearTimeout(bootTimer)
    if (refreshTimer) clearInterval(refreshTimer)
    if (fallbackTimer) clearInterval(fallbackTimer)
    if (idleTimer) clearTimeout(idleTimer)
    for (const timer of pending.values()) clearTimeout(timer)
    for (const watcher of watchers.values()) watcher.close()
    bootTimer = undefined
    refreshTimer = undefined
    fallbackTimer = undefined
    idleTimer = undefined
    watchers.clear()
    pending.clear()
    observations.clear()
    failedRoots.clear()
    layouts.clear()
    warned.clear()
    idleQueue.length = 0
    idleQueued.clear()
    targets.clear()
    revisions.clear()
  }
  return { start, stop, check }
}

const platformSkillSync = createPlatformSkillSync()
export const checkPlatformSkillChanges = platformSkillSync.check
export const startPlatformSkillSync = platformSkillSync.start
export const stopPlatformSkillSync = platformSkillSync.stop

if (import.meta.hot) {
  import.meta.hot.dispose(stopPlatformSkillSync)
}
