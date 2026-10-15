import { createFileRoute } from '@tanstack/react-router'
import { json } from '@tanstack/react-start'
import { isAuthenticated } from '../../server/auth-middleware'
import { requireJsonContentType } from '../../server/rate-limit'
import {
  createPlatformSkill,
  ensurePlatformSkillsSeeded,
  listPlatformSkills,
  type CreatePlatformSkillInput,
  type PlatformSkillFile,
  type PlatformSkillOrigin,
} from '../../server/platform-skills'

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

export const Route = createFileRoute('/api/platform-skills')({
  server: {
    handlers: {
      GET: async ({ request }) => {
        if (!isAuthenticated(request)) {
          return json({ error: 'Unauthorized' }, { status: 401 })
        }
        ensurePlatformSkillsSeeded()
        return json({ skills: listPlatformSkills() })
      },
      POST: async ({ request }) => {
        if (!isAuthenticated(request)) {
          return json({ error: 'Unauthorized' }, { status: 401 })
        }
        const ct = requireJsonContentType(request)
        if (ct) return ct
        const body = (await request.json().catch(() => ({}))) as Record<
          string,
          unknown
        >
        const name = typeof body.name === 'string' ? body.name : ''
        if (!name.trim()) {
          return json({ error: 'name is required' }, { status: 400 })
        }
        const input: CreatePlatformSkillInput = {
          name,
          description:
            typeof body.description === 'string' ? body.description : '',
          category:
            typeof body.category === 'string' ? body.category : '',
          content: typeof body.content === 'string' ? body.content : '',
          files: parseFiles(body.files),
          origin: parseOrigin(body.origin) ?? { kind: 'manual' },
        }
        try {
          const skill = createPlatformSkill(input)
          return json({ skill }, { status: 201 })
        } catch (error) {
          const message =
            error instanceof Error ? error.message : 'Failed to create skill'
          const status = message.includes('already exists') ? 409 : 400
          return json({ error: message }, { status })
        }
      },
    },
  },
})
