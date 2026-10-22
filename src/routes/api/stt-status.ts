import { createFileRoute } from '@tanstack/react-router'
import { json } from '@tanstack/react-start'
import { isAuthenticated } from '../../server/auth-middleware'
import {
  readHermesConfigFiles,
  resolveHermesConfigPaths,
} from '../../server/hermes-config-store'
import { resolveTranscriptionTarget } from '../../server/stt-transcription'

export const Route = createFileRoute('/api/stt-status')({
  server: {
    handlers: {
      GET: async ({ request }) => {
        if (!isAuthenticated(request)) {
          return json({ ok: false, error: 'Unauthorized' }, { status: 401 })
        }

        const profile =
          new URL(request.url).searchParams.get('profile')?.trim() ||
          new URL(request.url).searchParams.get('agent')?.trim() ||
          undefined
        const paths = resolveHermesConfigPaths(profile)
        const { config } = readHermesConfigFiles(paths)
        const stt =
          config.stt &&
          typeof config.stt === 'object' &&
          !Array.isArray(config.stt)
            ? (config.stt as Record<string, unknown>)
            : {}
        const provider =
          typeof stt.provider === 'string' && stt.provider.trim()
            ? stt.provider.trim()
            : 'local'
        const target = resolveTranscriptionTarget(config)

        return json({
          ok: true,
          provider,
          remoteReady: target.ok === true,
          error: target.ok === false ? target.error : null,
        })
      },
    },
  },
})
