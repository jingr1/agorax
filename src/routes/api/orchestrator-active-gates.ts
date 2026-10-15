import { createFileRoute } from '@tanstack/react-router'
import { json } from '@tanstack/react-start'
import { isAuthenticated } from '../../server/auth-middleware'
import {
  langgraphPythonMissingHint,
  parseJsonFromStdout,
  resolveLanggraphPythonBin,
  runLanggraphSync,
} from '../../server/langgraph-orchestrator'

export const Route = createFileRoute('/api/orchestrator-active-gates')({
  server: {
    handlers: {
      GET: async ({ request }) => {
        if (!isAuthenticated(request)) {
          return json({ ok: false, error: 'Unauthorized' }, { status: 401 })
        }

        const result = runLanggraphSync(['--list-active-gates'])
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
          const gates = parseJsonFromStdout(result.stdout)
          return json({ ok: true, gates })
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
