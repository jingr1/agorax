/**
 * Lightweight model list endpoint that reads ONLY from the local filesystem —
 * no gateway connection required.
 *
 *   GET /api/models-local
 *     → { ok: true, models: ModelEntry[] }
 *
 * Sources (merged, deduped by id):
 *   1. ~/.hermes/models.json          (user-configured model catalog)
 *   2. ~/.hermes/config.yaml `model`  (active default model)
 *
 * This is the fallback for the Operations detail panel model dropdown when the
 * gateway is unavailable. It will always return at least the configured default
 * model so the dropdown is never empty.
 */
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import YAML from 'yaml'
import { json } from '@tanstack/react-start'
import { createFileRoute } from '@tanstack/react-router'
import { isAuthenticated } from '../../server/auth-middleware'

const HERMES_HOME =
  process.env.HERMES_HOME ??
  process.env.HERMES_HOME ??
  path.join(os.homedir(), '.hermes')

type ModelEntry = {
  id: string
  name: string
  provider: string
}

function readModelsJson(): ModelEntry[] {
  const p = path.join(HERMES_HOME, 'models.json')
  try {
    if (!fs.existsSync(p)) return []
    const raw = fs.readFileSync(p, 'utf-8')
    const entries = JSON.parse(raw)
    if (!Array.isArray(entries)) return []
    return entries
      .map((entry: unknown): ModelEntry | null => {
        if (typeof entry === 'string') {
          const id = entry.trim()
          if (!id) return null
          return {
            id,
            name: id.split('/').pop() ?? id,
            provider: id.includes('/')
              ? (id.split('/')[0] ?? 'model')
              : 'model',
          }
        }
        if (!entry || typeof entry !== 'object') return null
        const r = entry as Record<string, unknown>
        const id =
          (typeof r.id === 'string' ? r.id.trim() : '') ||
          (typeof r.model === 'string' ? r.model.trim() : '') ||
          (typeof r.name === 'string' ? r.name.trim() : '')
        if (!id) return null
        return {
          id,
          name:
            (typeof r.name === 'string' ? r.name.trim() : '') ||
            (typeof r.label === 'string' ? r.label.trim() : '') ||
            (typeof r.display_name === 'string' ? r.display_name.trim() : '') ||
            (id.split('/').pop() ?? id),
          provider:
            (typeof r.provider === 'string' ? r.provider.trim() : '') ||
            (id.includes('/') ? (id.split('/')[0] ?? 'model') : 'model'),
        }
      })
      .filter((e): e is ModelEntry => e !== null)
  } catch {
    return []
  }
}

function readDefaultModelFromConfig(): ModelEntry | null {
  const p = path.join(HERMES_HOME, 'config.yaml')
  try {
    if (!fs.existsSync(p)) return null
    const parsed = YAML.parse(fs.readFileSync(p, 'utf-8'))
    if (!parsed || typeof parsed !== 'object') return null
    const model = (parsed as Record<string, unknown>).model
    if (typeof model !== 'string' || !model.trim()) return null
    const id = model.trim()
    return {
      id,
      name: id.split('/').pop() ?? id,
      provider: id.includes('/') ? (id.split('/')[0] ?? 'model') : 'model',
    }
  } catch {
    return null
  }
}

export const Route = createFileRoute('/api/models-local')({
  server: {
    handlers: {
      GET: async ({ request }) => {
        if (!isAuthenticated(request)) {
          return json({ ok: false, error: 'Unauthorized' }, { status: 401 })
        }

        const fromJson = readModelsJson()
        const defaultModel = readDefaultModelFromConfig()

        // Merge: models.json first, then add default model if not already present
        const seen = new Set(fromJson.map((m) => m.id))
        const merged: ModelEntry[] = [...fromJson]
        if (defaultModel && !seen.has(defaultModel.id)) {
          merged.unshift(defaultModel)
        }

        return json({ ok: true, models: merged })
      },
    },
  },
})
