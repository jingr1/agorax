import { createFileRoute } from '@tanstack/react-router'
import { json } from '@tanstack/react-start'
import { isAuthenticated } from '../../../server/auth-middleware'
import {
  loadPricingConfig,
  removePricingForModel,
  savePricingConfig,
  setDefaultMultiplier,
  setPricingForModel,
} from '../../../server/usage/pricing-store'
import type { ModelPricingEntry, PricingConfig } from '../../../server/usage/usage-types'

function maskConfig(config: PricingConfig): PricingConfig {
  return config
}

export const Route = createFileRoute('/api/usage/pricing')({
  server: {
    handlers: {
      GET: async ({ request }) => {
        if (!isAuthenticated(request)) {
          return json({ ok: false, error: 'Unauthorized' }, { status: 401 })
        }
        const config = loadPricingConfig()
        return json(maskConfig(config))
      },

      POST: async ({ request }) => {
        if (!isAuthenticated(request)) {
          return json({ ok: false, error: 'Unauthorized' }, { status: 401 })
        }

        const body = (await request.json()) as
          | { action: 'set-model'; entry: ModelPricingEntry }
          | { action: 'set-multiplier'; multiplier: string }
          | { action: 'reset' }

        if (body.action === 'set-model') {
          setPricingForModel(body.entry)
        } else if (body.action === 'set-multiplier') {
          setDefaultMultiplier(body.multiplier)
        } else if (body.action === 'reset') {
          savePricingConfig({
            defaultMultiplier: '1',
            models: {},
            updatedAt: Date.now(),
          })
        } else {
          return json({ ok: false, error: 'Unknown action' }, { status: 400 })
        }

        return json(maskConfig(loadPricingConfig()))
      },

      DELETE: async ({ request }) => {
        if (!isAuthenticated(request)) {
          return json({ ok: false, error: 'Unauthorized' }, { status: 401 })
        }
        const url = new URL(request.url)
        const modelId = url.searchParams.get('modelId')?.trim()
        if (!modelId) {
          return json(
            { ok: false, error: 'modelId required' },
            { status: 400 },
          )
        }
        removePricingForModel(modelId)
        return json(maskConfig(loadPricingConfig()))
      },
    },
  },
})
