import { createFileRoute } from '@tanstack/react-router'
import { json } from '@tanstack/react-start'
import { isAuthenticated } from '../../server/auth-middleware'
import {
  langgraphPythonMissingHint,
  parseJsonFromStdout,
  resolveLanggraphPythonBin,
  runLanggraphSync,
} from '../../server/langgraph-orchestrator'

export const Route = createFileRoute('/api/orchestrator-state')({
  server: {
    handlers: {
      GET: async ({ request }) => {
        if (!isAuthenticated(request)) {
          return json({ ok: false, error: 'Unauthorized' }, { status: 401 })
        }
        const url = new URL(request.url)
        const missionId = url.searchParams.get('missionId')?.trim()
        if (!missionId) {
          return json(
            { ok: false, error: 'missionId required' },
            { status: 400 },
          )
        }

        const result = runLanggraphSync([
          '--get-state',
          '--mission-id',
          missionId,
        ])
        if (!result.ok) {
          const python = resolveLanggraphPythonBin()
          return json(
            {
              ok: false,
              error: result.error || langgraphPythonMissingHint(python),
              stderr: result.stderr?.slice(0, 2000) || null,
            },
            { status: 500 },
          )
        }

        try {
          const state = parseJsonFromStdout(result.stdout)
          if (state === null) {
            return json(
              { ok: false, error: 'Mission state not found' },
              { status: 404 },
            )
          }
          return json({ ok: true, state })
        } catch (e) {
          return json(
            {
              ok: false,
              error: 'Invalid JSON from orchestrator',
              details: e instanceof Error ? e.message : String(e),
              stdout: result.stdout?.slice(0, 2000) ?? null,
            },
            { status: 500 },
          )
        }
      },
    },
  },
})
