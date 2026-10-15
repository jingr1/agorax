/**
 * Scan Codex CLI session JSONL files from the local sessions directory.
 *
 * Mirrors cc-switch's session_manager/providers/codex.rs approach.
 * Newer Codex JSONL emits a `token_count` event per turn with precise
 * input/output/cache/reasoning counts; we prefer those when present and
 * fall back to character-based estimates for older files.
 */
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { estimateTokens } from './session-token-estimator'

export interface CodexSessionRecord {
  sessionId: string
  providerId: string
  agentId: string
  profile: string
  model: string
  title?: string
  createdAt: number
  lastActiveAt: number
  sourcePath: string
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  cacheCreationTokens: number
}

function getCodexConfigDir(): string {
  return path.join(os.homedir(), '.codex')
}

function collectJsonlFiles(root: string, out: string[]): void {
  if (!fs.existsSync(root)) return
  const entries = fs.readdirSync(root, { withFileTypes: true })
  for (const entry of entries) {
    const full = path.join(root, entry.name)
    if (entry.isDirectory()) {
      collectJsonlFiles(full, out)
    } else if (entry.isFile() && entry.name.endsWith('.jsonl')) {
      out.push(full)
    }
  }
}

function parseTimestamp(value: unknown): number | undefined {
  if (typeof value === 'number') return value > 1e11 ? value : value * 1000
  if (typeof value === 'string') {
    const n = Date.parse(value)
    if (Number.isFinite(n)) return n
  }
  return undefined
}

function extractText(value: unknown): string {
  if (typeof value === 'string') return value
  if (value && typeof value === 'object') {
    if (Array.isArray(value)) {
      return value.map(extractText).join('\n')
    }
    const obj = value as Record<string, unknown>
    if (typeof obj.text === 'string') return obj.text
    if (typeof obj.output === 'string') return obj.output
    return Object.values(obj).map(extractText).join('\n')
  }
  return ''
}

function parseSessionFile(filePath: string): CodexSessionRecord | null {
  try {
    const stat = fs.statSync(filePath)
    if (!stat.isFile()) return null

    let inputTokens = 0
    let outputTokens = 0
    let cacheReadTokens = 0
    let cacheCreationTokens = 0
    let hasExactTokenCounts = false
    let firstTs: number | undefined
    let lastTs: number | undefined
    let firstUserMessage: string | undefined
    let model: string | undefined

    const lines = fs.readFileSync(filePath, 'utf-8').split('\n')
    for (const line of lines) {
      if (!line.trim()) continue
      let record: unknown
      try {
        record = JSON.parse(line)
      } catch {
        continue
      }
      if (!record || typeof record !== 'object') continue
      const obj = record as Record<string, unknown>

      const ts = parseTimestamp(obj.timestamp)
      if (ts) {
        if (firstTs === undefined || ts < firstTs) firstTs = ts
        if (lastTs === undefined || ts > lastTs) lastTs = ts
      }

      // Prefer the model declared in session_meta.
      if (obj.type === 'session_meta' && !model) {
        const payload = obj.payload as Record<string, unknown> | undefined
        const candidate =
          payload?.model ??
          (payload as Record<string, unknown> | undefined)?.model_provider
        if (typeof candidate === 'string') model = candidate
      }

      // Exact token counts from newer Codex sessions.
      if (obj.type === 'token_count') {
        const info = obj.info as Record<string, unknown> | undefined
        const total = info?.total_token_usage as
          | Record<string, unknown>
          | undefined
        if (total && typeof total === 'object') {
          hasExactTokenCounts = true
          inputTokens += Math.max(
            0,
            Number(total.input_tokens) || 0,
          )
          outputTokens += Math.max(
            0,
            Number(total.output_tokens) || 0,
          )
          cacheReadTokens += Math.max(
            0,
            Number(total.cached_input_tokens) || 0,
          )
          cacheCreationTokens += Math.max(
            0,
            Number(total.cache_write_input_tokens) || 0,
          )
        }
        continue
      }

      // Fall back to text estimation only when no token_count event is seen.
      if (hasExactTokenCounts) continue

      if (obj.type !== 'response_item') continue
      const payload = obj.payload as Record<string, unknown> | undefined
      if (!payload) continue

      const payloadType =
        typeof payload.type === 'string' ? payload.type.toLowerCase() : ''

      if (payloadType === 'message') {
        const role =
          typeof payload.role === 'string'
            ? payload.role.toLowerCase()
            : ''
        const text = extractText(payload.content)
        if (!text.trim()) continue
        if (role === 'user') {
          inputTokens += estimateTokens(text)
          if (!firstUserMessage) firstUserMessage = text.trim()
        } else if (role === 'assistant') {
          outputTokens += estimateTokens(text)
        }
      } else if (payloadType === 'function_call') {
        const text = extractText(payload)
        if (text.trim()) {
          outputTokens += estimateTokens(text)
        }
      } else if (payloadType === 'function_call_output') {
        const text = extractText(payload)
        if (text.trim()) {
          inputTokens += estimateTokens(text)
        }
      }
    }

    if (inputTokens === 0 && outputTokens === 0) return null

    const createdAt = firstTs ?? stat.mtimeMs
    const lastActiveAt = lastTs ?? stat.mtimeMs
    const sessionId = path.basename(filePath, '.jsonl')

    return {
      sessionId,
      providerId: 'codex',
      agentId: 'codex-impl',
      profile: inferCodexProfile(),
      model: model ?? inferCodexModel(),
      title: firstUserMessage,
      createdAt,
      lastActiveAt,
      sourcePath: filePath,
      inputTokens,
      outputTokens,
      cacheReadTokens,
      cacheCreationTokens,
    }
  } catch (error) {
    console.warn(
      `[codex-session-scanner] failed to parse ${filePath}: ${
        error instanceof Error ? error.message : String(error)
      }`,
    )
    return null
  }
}

function inferCodexProfile(): string {
  try {
    const configPath = path.join(getCodexConfigDir(), 'config.toml')
    if (!fs.existsSync(configPath)) return 'default'
    const raw = fs.readFileSync(configPath, 'utf-8')
    const providerMatch = raw.match(/^provider\s*=\s*["']([^"']+)["']/m)
    if (providerMatch) return providerMatch[1]
  } catch {
    // ignore
  }
  return 'default'
}

function inferCodexModel(): string {
  try {
    const configPath = path.join(getCodexConfigDir(), 'config.toml')
    if (!fs.existsSync(configPath)) return 'unknown'
    const raw = fs.readFileSync(configPath, 'utf-8')
    const modelMatch = raw.match(/^model\s*=\s*["']([^"']+)["']/m)
    if (modelMatch) return modelMatch[1]
  } catch {
    // ignore
  }
  return 'unknown'
}

export function scanCodexSessions(): CodexSessionRecord[] {
  const roots = [
    path.join(getCodexConfigDir(), 'sessions'),
    path.join(getCodexConfigDir(), 'archived_sessions'),
  ]
  const files: string[] = []
  for (const root of roots) {
    collectJsonlFiles(root, files)
  }

  const sessions: CodexSessionRecord[] = []
  for (const file of files) {
    const session = parseSessionFile(file)
    if (session) sessions.push(session)
  }

  return sessions.sort((a, b) => b.createdAt - a.createdAt)
}
