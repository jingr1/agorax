import fs from 'node:fs'
import path from 'node:path'
import { createFileRoute } from '@tanstack/react-router'
import { json } from '@tanstack/react-start'
import { isAuthenticated } from '../../../server/auth-middleware'
import {
  normalizeMemoryAgentId,
  resolveMemoryAgentScope,
  resolveMemoryFilePath,
} from '../../../server/memory-browser'
import { requireJsonContentType } from '../../../server/rate-limit'

export const Route = createFileRoute('/api/memory/write')({
  server: {
    handlers: {
      POST: async ({ request }) => {
        if (!isAuthenticated(request)) {
          return json({ error: 'Unauthorized' }, { status: 401 })
        }
        const csrfCheck = requireJsonContentType(request)
        if (csrfCheck) return csrfCheck
        try {
          const body = (await request.json().catch(() => ({}))) as {
            path?: unknown
            content?: unknown
            agent?: unknown
          }
          const agentId = normalizeMemoryAgentId(
            typeof body.agent === 'string' ? body.agent : null,
          )
          const scope = resolveMemoryAgentScope(agentId)
          if (scope.memoryKind === 'unsupported' || !scope.root) {
            return json(
              {
                error: `Agent "${scope.id}" (${scope.runtime}) has no browsable memory home`,
              },
              { status: 400 },
            )
          }
          if (!scope.writable) {
            return json(
              {
                error: `Memory for "${scope.id}" (${scope.runtime}) is read-only in this browser`,
              },
              { status: 400 },
            )
          }

          const resolved = resolveMemoryFilePath(
            typeof body.path === 'string' ? body.path : '',
            agentId,
          )
          if (resolved.virtual) {
            return json(
              { error: 'Virtual memory entries cannot be written here' },
              { status: 400 },
            )
          }

          const content = typeof body.content === 'string' ? body.content : ''
          fs.mkdirSync(path.dirname(resolved.fullPath), { recursive: true })
          fs.writeFileSync(resolved.fullPath, content, 'utf-8')
          return json({
            success: true,
            path: resolved.relativePath,
            agentId: scope.id,
          })
        } catch (error) {
          const message =
            error instanceof Error
              ? error.message
              : 'Failed to write memory file'
          const status =
            /required|absolute|traversal|outside workspace|\.md|Invalid agent|not an allowed|read-only|Virtual|no browsable/i.test(
              message,
            )
              ? 400
              : 500
          return json({ error: message }, { status })
        }
      },
    },
  },
})
