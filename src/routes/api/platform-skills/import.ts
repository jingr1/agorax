import { createFileRoute } from '@tanstack/react-router'
import { json } from '@tanstack/react-start'
import { isAuthenticated } from '../../../server/auth-middleware'
import { requireJsonContentType } from '../../../server/rate-limit'
import {
  importSkillFromArchive,
  importSkillFromFiles,
  importSkillFromUrl,
  MAX_SKILL_ARCHIVE_BYTES,
  type PlatformSkillFile,
} from '../../../server/platform-skills'

function parseFiles(value: unknown): Array<PlatformSkillFile> {
  if (!Array.isArray(value)) return []
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

export const Route = createFileRoute('/api/platform-skills/import')({
  server: {
    handlers: {
      POST: async ({ request }) => {
        if (!isAuthenticated(request)) {
          return json({ error: 'Unauthorized' }, { status: 401 })
        }
        const contentType = (request.headers.get('content-type') || '').toLowerCase()

        try {
          if (contentType.includes('multipart/form-data')) {
            const form = await request.formData()
            const file = form.get('file')
            if (!(file instanceof File)) {
              return json(
                { error: 'a skill archive file is required (form field "file")' },
                { status: 400 },
              )
            }
            if (file.size > MAX_SKILL_ARCHIVE_BYTES) {
              return json({ error: 'Archive exceeds 16 MiB limit' }, { status: 413 })
            }
            const buffer = Buffer.from(await file.arrayBuffer())
            const skill = importSkillFromArchive(buffer, file.name)
            return json({ skill }, { status: 201 })
          }

          const ct = requireJsonContentType(request)
          if (ct) return ct
          const body = (await request.json().catch(() => ({}))) as Record<
            string,
            unknown
          >

          if (typeof body.url === 'string' && body.url.trim()) {
            const skill = await importSkillFromUrl(body.url.trim())
            return json({ skill }, { status: 201 })
          }

          const files = parseFiles(body.files)
          if (files.length > 0) {
            const skill = importSkillFromFiles(files, {
              fallbackName:
                typeof body.name === 'string' ? body.name : undefined,
              source: 'local-files',
            })
            return json({ skill }, { status: 201 })
          }

          return json(
            {
              error:
                'Provide { url }, { files: [{ path, content }] }, or multipart file',
            },
            { status: 400 },
          )
        } catch (error) {
          const message =
            error instanceof Error ? error.message : 'Import failed'
          const status = message.includes('already exists')
            ? 409
            : message.includes('too large') || message.includes('16 MiB')
              ? 413
              : 400
          return json({ error: message }, { status })
        }
      },
    },
  },
})
