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
  type PlatformSkillFile,
  type PlatformSkillOrigin,
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
        const skillId =
          typeof params.skillId === 'string' ? params.skillId : ''
        const skill = getPlatformSkill(skillId, { includeFiles: true })
        if (!skill) {
          return json({ error: 'Skill not found' }, { status: 404 })
        }
        const agents = listSkillAgentBindings(skill.id)
        return json({ skill, agents })
      },
      PATCH: async ({ request, params }) => {
        if (!isAuthenticated(request)) {
          return json({ error: 'Unauthorized' }, { status: 401 })
        }
        const ct = requireJsonContentType(request)
        if (ct) return ct
        const skillId =
          typeof params.skillId === 'string' ? params.skillId : ''
        const body = (await request.json().catch(() => ({}))) as Record<
          string,
          unknown
        >
        try {
          const skill = updatePlatformSkill(skillId, {
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
          // Re-materialize Hermes agents that bind this skill.
          for (const binding of listSkillAgentBindings(skill.id)) {
            materializeHermesAgentSkills(binding.agentId)
          }
          return json({ skill })
        } catch (error) {
          const message =
            error instanceof Error ? error.message : 'Failed to update skill'
          const status = message.includes('not found')
            ? 404
            : message.includes('already exists')
              ? 409
              : 400
          return json({ error: message }, { status })
        }
      },
      DELETE: async ({ request, params }) => {
        if (!isAuthenticated(request)) {
          return json({ error: 'Unauthorized' }, { status: 401 })
        }
        const skillId =
          typeof params.skillId === 'string' ? params.skillId : ''
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
