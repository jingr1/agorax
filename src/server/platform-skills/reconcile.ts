import * as fs from 'node:fs'
import * as path from 'node:path'
import { createCollabId } from '../collab-db'
import {
  getPlatformSkill,
  listSkillAgentBindings,
  updatePlatformSkill,
  withPlatformSkillDb,
} from './store'
import {
  PLATFORM_MARKER,
  hashSkillTree,
  readSkillMarker,
  readSkillTree,
  recoverSkillTree,
  writeSkillTree,
} from './skill-tree'
import { listSkillDeployments, withSkillSyncOperation } from './sync-state'
import { platformSkillTarget } from './runtime-target'
import {
  deploySkillTree,
  isOwnedSkillLink,
  readSkillDeployment,
  recoverSkillDeployment,
  skillPathExists,
  skillWorkingDirectory,
} from './deployment-tree'
import type { SkillTree } from './skill-tree'

export function resolveSkillDeployment(input: {
  skillId: string
  agentId: string
  action: 'use-catalog' | 'publish-local'
  expectedRevision: string
  observedHash: string
}): Array<SkillDeploymentResult> {
  return withSkillSyncOperation(input.skillId, () => {
    const skill = getPlatformSkill(input.skillId)
    if (!skill) throw new Error('Skill not found')
    if ((skill.revisionId ?? '') !== input.expectedRevision)
      throw new Error('Revision conflict: reload before resolving')
    const deployment = listSkillDeployments(skill.id).find(
      (entry) => entry.agentId === input.agentId,
    )
    if (!deployment?.path) throw new Error('Deployment not found')
    const tree = readSkillDeployment(deployment.path, skill.id)
    const hash = hashSkillTree(tree)
    if (hash !== input.observedHash)
      throw new Error('Revision conflict: local files changed since preview')
    withPlatformSkillDb((db) =>
      db
        .prepare(
          'INSERT INTO skill_revisions (id, skill_id, parent_id, tree_hash, snapshot_json, created_at) VALUES (?, ?, ?, ?, ?, ?)',
        )
        .run(
          createCollabId('snapshot'),
          skill.id,
          skill.revisionId ?? null,
          hash,
          JSON.stringify({ ...skill, ...tree }),
          Date.now(),
        ),
    )
    const chosen =
      input.action === 'publish-local'
        ? updatePlatformSkill(skill.id, {
            ...tree,
            expectedRevision: input.expectedRevision,
          })
        : skill
    writeSkillTree(
      isOwnedSkillLink(deployment.path, skill.id)
        ? skillWorkingDirectory(skill.id)
        : deployment.path,
      skill.id,
      chosen,
      hash,
    )
    return reconcileSkillCopies(skill.id)
  })
}

export type SkillDeploymentResult = {
  agentId: string
  skillId: string
  name: string
  status:
    | 'in-sync'
    | 'conflict'
    | 'external-visible'
    | 'error'
    | 'prompt-only'
    | 'pending'
    | 'unsupported'
  path?: string
  message?: string
  hash?: string
  delivery?: 'native' | 'on-demand'
  actualMode?: 'symlink' | 'copy'
  sourcePath?: string
}

export function reconcilePlatformSkill(
  skillId: string,
): Array<SkillDeploymentResult> {
  return withSkillSyncOperation(skillId, () => reconcileSkillCopies(skillId))
}

function reconcileSkillCopies(skillId: string): Array<SkillDeploymentResult> {
  let skill = getPlatformSkill(skillId)
  if (!skill) return []
  const results: Array<SkillDeploymentResult> = []
  const observed: Array<{
    result: SkillDeploymentResult
    tree?: SkillTree
    base?: string
  }> = []
  const previous = listSkillDeployments(skill.id)
  const central = skillWorkingDirectory(skill.id)
  const centralResult: SkillDeploymentResult = {
    agentId: '@library',
    skillId: skill.id,
    name: skill.name,
    status: 'in-sync',
    path: central,
  }
  recoverSkillTree(central, skill.id)
  if (skillPathExists(central)) {
    const marker = readSkillMarker(central)
    if (marker?.skillId !== skill.id)
      throw new Error('Central skill directory ownership is unknown')
    const tree = readSkillTree(central)
    centralResult.hash = hashSkillTree(tree)
    observed.push({ result: centralResult, tree, base: marker.baseHash })
  } else observed.push({ result: centralResult })
  for (const binding of listSkillAgentBindings(skill.id)) {
    const result: SkillDeploymentResult = {
      agentId: binding.agentId,
      skillId: skill.id,
      name: skill.name,
      status: 'in-sync',
    }
    results.push(result)
    const target = platformSkillTarget(binding.agentId)
    if (target.remote) {
      result.status = 'unsupported'
      result.message =
        'Remote skill deployment requires a remote filesystem adapter'
      continue
    }
    if (!target.root) {
      result.status = 'prompt-only'
      continue
    }
    result.delivery = target.runtime === 'hermes' ? 'native' : 'on-demand'
    if (!/^[a-z0-9][a-z0-9._-]*$/i.test(skill.name)) {
      result.status = 'error'
      result.message = 'Invalid skill directory name'
      continue
    }
    result.path = path.join(target.root, skill.name)
    result.sourcePath = central
    try {
      const old = previous.find(
        (entry) =>
          entry.agentId === binding.agentId &&
          entry.path &&
          entry.path !== result.path,
      )
      if (
        old?.path &&
        path.dirname(old.path) === target.root &&
        skillPathExists(old.path)
      ) {
        const marker = readSkillMarker(old.path)
        if (marker?.skillId === skill.id) {
          const hash = hashSkillTree(readSkillDeployment(old.path, skill.id))
          if (hash !== marker.baseHash || skillPathExists(result.path)) {
            result.path = old.path
            result.hash = hash
            result.status = 'conflict'
            result.message =
              'Rename conflicts with local files; the previous directory was preserved'
            continue
          }
          fs.renameSync(old.path, result.path)
        }
      }
      recoverSkillDeployment(result.path, skill.id)
      if (
        !skillPathExists(result.path) ||
        (isOwnedSkillLink(result.path, skill.id) && !fs.existsSync(central))
      ) {
        observed.push({ result })
        continue
      }
      const linked = isOwnedSkillLink(result.path, skill.id)
      result.actualMode = linked ? 'symlink' : 'copy'
      if (
        (!linked && !fs.lstatSync(result.path).isDirectory()) ||
        !fs.existsSync(path.join(result.path, PLATFORM_MARKER))
      ) {
        // Category folders (e.g. skills/github/) and other unmanaged trees stay
        // external-visible. Missing SKILL.md is expected and must not become
        // a hard error that blocks sync or floods logs.
        result.status = 'external-visible'
        result.message = 'Existing directory is not managed by Agorax'
        if (
          fs.lstatSync(result.path).isDirectory() &&
          fs.existsSync(path.join(result.path, 'SKILL.md'))
        ) {
          try {
            result.hash = hashSkillTree(readSkillTree(result.path))
          } catch {
            /* hash is best-effort for unmanaged trees */
          }
        }
        continue
      }
      const tree = readSkillDeployment(result.path, skill.id)
      result.hash = hashSkillTree(tree)
      const marker = readSkillMarker(result.path)
      if (marker && marker.skillId !== skill.id)
        throw new Error('Skill deployment identity mismatch')
      const base = marker?.baseHash
      if (!base && result.hash !== hashSkillTree(skill)) {
        result.status = 'conflict'
        result.message =
          'Legacy deployment differs from catalog; adopt or resolve explicitly'
        continue
      }
      observed.push({ result, tree, base: base ?? result.hash })
    } catch (error) {
      result.status = 'error'
      result.message = error instanceof Error ? error.message : String(error)
    }
  }
  const catalogHash = hashSkillTree(skill)
  const dirty = observed.filter(
    (entry) =>
      entry.tree &&
      entry.result.hash !== entry.base &&
      entry.result.hash !== catalogHash,
  )
  const edits = new Set(dirty.map((entry) => entry.result.hash))
  if (edits.size === 1 && dirty.every((entry) => entry.base === catalogHash)) {
    const tree = dirty[0].tree!
    skill = updatePlatformSkill(skill.id, {
      content: tree.content,
      files: tree.files,
      expectedRevision: skill.revisionId ?? '',
    })
  } else {
    for (const entry of dirty) {
      entry.result.status = 'conflict'
      entry.result.message =
        'Catalog or another agent and this copy changed; local files were preserved'
    }
  }
  const centralEntry = observed.find((entry) => entry.result === centralResult)!
  if (centralResult.status === 'in-sync') {
    if (
      centralResult.hash !== hashSkillTree(skill) ||
      centralEntry.base !== centralResult.hash
    ) {
      writeSkillTree(central, skill.id, skill, centralResult.hash)
    }
  }
  for (const entry of observed) {
    if (entry.result === centralResult) continue
    if (entry.result.status !== 'in-sync') continue
    try {
      if (
        centralResult.status !== 'in-sync' &&
        (skill.deploymentMode ?? 'symlink') === 'symlink'
      ) {
        entry.result.status = 'conflict'
        entry.result.message =
          'Central working copy conflicts with the catalog; files were preserved'
        continue
      }
      const currentHash = isOwnedSkillLink(entry.result.path!, skill.id)
        ? hashSkillTree(readSkillTree(central))
        : entry.result.hash
      const deployed = deploySkillTree(entry.result.path!, skill.id, skill, {
        mode: skill.deploymentMode ?? 'symlink',
        allowCopyFallback: skill.allowCopyFallback !== false,
        expectedHash: currentHash,
      })
      entry.result.actualMode = deployed.actualMode
      entry.result.message = deployed.message
      entry.result.hash = hashSkillTree(skill)
    } catch (error) {
      entry.result.status = 'error'
      entry.result.message =
        error instanceof Error ? error.message : String(error)
    }
  }
  return results
}
