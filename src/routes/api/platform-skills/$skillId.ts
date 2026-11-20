import { createFileRoute } from '@tanstack/react-router'
import { json } from '@tanstack/react-start'
import { isAuthenticated } from '../../../server/auth-middleware'
import { requireJsonContentType } from '../../../server/rate-limit'
import {
  deletePlatformSkill,
  getPlatformSkill,
  listSkillAgentBindings,
  materializeHermesAgentSkills,
  updatePlatformSkill,
} from '../../../server/platform-skills'
import { listSkillDeployments } from '../../../server/platform-skills/sync-state'
import { startPlatformSkillSync } from '../../../server/platform-skills/sync-loop'
import {
  getSkillRevision,
  listSkillRevisions,
} from '../../../server/platform-skills/store'
import {
  reconcilePlatformSkill,
  resolveSkillDeployment,
} from '../../../server/platform-skills/reconcile'
import type {
  PlatformSkillFile,
  PlatformSkillOrigin,
} from '../../../server/platform-skills'

function parseFiles(value: unknown): Array<PlatformSkillFile> | undefined {
  if (!Array.isArray(value)) return undefined
  const files: Array<PlatformSkillFile> = []
  for (const entry of value) {
    if (!entry || typeof entry !== 'object') continue
    const record = entry as Record<string, unknown>
    const path = typeof record.path === 'string' ? record.path.trim() : ''
    if (!path) continue
    files.push({
      path,
      content: typeof record.content === 'string' ? record.content : '',
      ...(record.encoding === 'base64' ? { encoding: 'base64' } : {}),
      ...(record.executable === true ? { executable: true } : {}),
    })
  }
  return files
}

function parseOrigin(value: unknown): PlatformSkillOrigin | undefined {
  if (!value || typeof value !== 'object') return undefined
  const kind = (value as Record<string, unknown>).kind
  if (
    kind !== 'manual' &&
    kind !== 'agents_yaml' &&
    kind !== 'hub' &&
    kind !== 'profile_fs' &&
    kind !== 'import'
  ) {
    return undefined
  }
  return value as PlatformSkillOrigin
}

export const Route = createFileRoute('/api/platform-skills/$skillId')({
  server: {
    handlers: {
      GET: async ({ request, params }) => {
        if (!isAuthenticated(request)) {
          return json({ error: 'Unauthorized' }, { status: 401 })
        }
        const skillId = typeof params.skillId === 'string' ? params.skillId : ''
        const skill = getPlatformSkill(skillId, { includeFiles: true })
        if (!skill) {
          return json({ error: 'Skill not found' }, { status: 404 })
        }
        const agents = listSkillAgentBindings(skill.id)
        startPlatformSkillSync()
        return json({
          skill,
          agents,
          deployments: listSkillDeployments(skill.id),
          revisions: listSkillRevisions(skill.id),
        })
      },
      PATCH: async ({ request, params }) => {
        if (!isAuthenticated(request)) {
          return json({ error: 'Unauthorized' }, { status: 401 })
        }
        const ct = requireJsonContentType(request)
        if (ct) return ct
        const skillId = typeof params.skillId === 'string' ? params.skillId : ''
        const body = (await request.json().catch(() => ({}))) as Record<
          string,
          unknown
        >
        try {
          if (
            body.deploymentMode !== undefined &&
            body.deploymentMode !== 'symlink' &&
            body.deploymentMode !== 'copy'
          )
            return json({ error: 'Invalid deployment mode' }, { status: 400 })
          if (
            body.allowCopyFallback !== undefined &&
            typeof body.allowCopyFallback !== 'boolean'
          )
            return json(
              { error: 'allowCopyFallback must be a boolean' },
              { status: 400 },
            )
          const skill = updatePlatformSkill(skillId, {
            deploymentMode: body.deploymentMode,
            allowCopyFallback: body.allowCopyFallback,
            expectedRevision:
              typeof body.expectedRevision === 'string'
                ? body.expectedRevision
                : undefined,
            name: typeof body.name === 'string' ? body.name : undefined,
            description:
              typeof body.description === 'string'
                ? body.description
                : undefined,
            content:
              typeof body.content === 'string' ? body.content : undefined,
            category:
              typeof body.category === 'string' ? body.category : undefined,
            files: parseFiles(body.files),
            origin: parseOrigin(body.origin),
          })
          const deployments = reconcilePlatformSkill(skill.id)
          startPlatformSkillSync()
          return json({ skill: getPlatformSkill(skill.id), deployments })
        } catch (error) {
          const message =
            error instanceof Error ? error.message : 'Failed to update skill'
          const status = message.includes('not found')
            ? 404
            : message.includes('already exists') ||
                message.includes('Revision conflict')
              ? 409
              : 400
          return json({ error: message }, { status })
        }
      },
      POST: async ({ request, params }) => {
        if (!isAuthenticated(request))
          return json({ error: 'Unauthorized' }, { status: 401 })
        const ct = requireJsonContentType(request)
        if (ct) return ct
        const body = (await request.json().catch(() => ({}))) as Record<
          string,
          unknown
        >
        const skillId = params.skillId
        try {
          if (!getPlatformSkill(skillId))
            return json({ error: 'Skill not found' }, { status: 404 })
          startPlatformSkillSync()
          if (body.action === 'sync')
            return json({ deployments: reconcilePlatformSkill(skillId) })
          if (
            body.action === 'restore' &&
            typeof body.revisionId === 'string' &&
            typeof body.expectedRevision === 'string'
          ) {
            const snapshot = getSkillRevision(skillId, body.revisionId)
            if (!snapshot)
              return json({ error: 'Revision not found' }, { status: 404 })
            const skill = updatePlatformSkill(skillId, {
              ...snapshot,
              expectedRevision: body.expectedRevision,
            })
            return json({
              skill,
              deployments: reconcilePlatformSkill(skill.id),
            })
          }
          if (
            (body.action === 'use-catalog' ||
              body.action === 'publish-local') &&
            typeof body.agentId === 'string' &&
            typeof body.observedHash === 'string' &&
            typeof body.expectedRevision === 'string'
          ) {
            return json({
              deployments: resolveSkillDeployment({
                skillId,
                agentId: body.agentId,
                action: body.action,
                expectedRevision: body.expectedRevision,
                observedHash: body.observedHash,
              }),
            })
          }
          return json({ error: 'Invalid skill operation' }, { status: 400 })
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error)
          return json(
            { error: message },
            { status: message.includes('conflict') ? 409 : 400 },
          )
        }
      },
      DELETE: async ({ request, params }) => {
        if (!isAuthenticated(request)) {
          return json({ error: 'Unauthorized' }, { status: 401 })
        }
        const skillId = typeof params.skillId === 'string' ? params.skillId : ''
        const agents = listSkillAgentBindings(skillId)
        const ok = deletePlatformSkill(skillId)
        if (!ok) {
          return json({ error: 'Skill not found' }, { status: 404 })
        }
        for (const binding of agents) {
          materializeHermesAgentSkills(binding.agentId)
        }
        return json({ ok: true })
      },
    },
  },
})
