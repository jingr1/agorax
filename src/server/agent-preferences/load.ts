/**
 * Load workspace agent preferences (write-once, all agent turns).
 *
 * Precedence:
 * 1. AGORAX_AGENT_PREFERENCES_TEXT
 * 2. AGORAX_AGENT_PREFERENCES_PATH (or cwd/agent-preferences.md)
 * 3. Bundled default.md
 *
 * Empty text disables injection.
 */
import { readFileSync, existsSync, statSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const LOCAL_FILENAME = 'agent-preferences.md'

let cachedText: string | null = null
let cachedSource = ''
let cachedMtimeMs = -1

function bundledDefaultPath(): string {
  return path.join(path.dirname(fileURLToPath(import.meta.url)), 'default.md')
}

function resolveLocalPath(): string {
  const fromEnv = process.env.AGORAX_AGENT_PREFERENCES_PATH?.trim()
  if (fromEnv) return path.resolve(fromEnv)
  return path.resolve(process.cwd(), LOCAL_FILENAME)
}

function readFileText(filePath: string): { text: string; mtimeMs: number } | null {
  if (!existsSync(filePath)) return null
  const mtimeMs = statSync(filePath).mtimeMs
  return { text: readFileSync(filePath, 'utf8'), mtimeMs }
}

/** Reset file/env cache (tests only). */
export function resetAgentPreferencesCacheForTests(): void {
  cachedText = null
  cachedSource = ''
  cachedMtimeMs = -1
}

/**
 * Current preferences body (trimmed). Empty string means "do not inject".
 */
export function loadAgentPreferencesText(): string {
  const envText = process.env.AGORAX_AGENT_PREFERENCES_TEXT
  if (envText !== undefined) {
    const source = 'env:text'
    if (cachedSource === source && cachedText !== null) return cachedText
    cachedSource = source
    cachedMtimeMs = -1
    cachedText = envText.trim()
    return cachedText
  }

  const localPath = resolveLocalPath()
  const local = readFileText(localPath)
  if (local) {
    const source = `file:${localPath}`
    if (
      cachedSource === source &&
      cachedMtimeMs === local.mtimeMs &&
      cachedText !== null
    ) {
      return cachedText
    }
    cachedSource = source
    cachedMtimeMs = local.mtimeMs
    cachedText = local.text.trim()
    return cachedText
  }

  const bundledPath = bundledDefaultPath()
  const bundled = readFileText(bundledPath)
  const source = `file:${bundledPath}`
  const mtimeMs = bundled?.mtimeMs ?? 0
  if (
    cachedSource === source &&
    cachedMtimeMs === mtimeMs &&
    cachedText !== null
  ) {
    return cachedText
  }
  cachedSource = source
  cachedMtimeMs = mtimeMs
  cachedText = (bundled?.text ?? '').trim()
  return cachedText
}
