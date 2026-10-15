/**
 * Scan Claude Code session JSONL files from the local projects directory.
 *
 * Mirrors cc-switch's session_manager/providers/claude.rs approach.
 * Newer Claude Code JSONL emits `token_count` style usage summaries; we
 * prefer those and fall back to character-based estimates when absent.
 */
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { estimateTokens } from './session-token-estimator'

export interface ClaudeSessionRecord {
  sessionId: string
  providerId: string
  agentId: string
  profile: string
  model: string
  projectDir?: string
  title?: string
  createdAt: number
  lastActiveAt: number
  sourcePath: string
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  cacheCreationTokens: number
}

function getClaudeProjectsDir(): string {
  return path.join(os.homedir(), '.claude', 'projects')
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
    if (typeof obj.content === 'string') return obj.content
    return Object.values(obj).map(extractText).join('\n')
  }
  return ''
}

function readTokenCount(
  obj: Record<string, unknown>,
): {
  input: number
  output: number
  cacheRead: number
  cacheCreation: number
} | null {
  const find = (
    root: Record<string, unknown>,
    keys: string[],
  ): number | undefined => {
    for (const key of keys) {
      const value = root[key]
      if (typeof value === 'number' && Number.isFinite(value)) return value
      if (value && typeof value === 'object' && !Array.isArray(value)) {
        const nested = value as Record<string, unknown>
        for (const k of keys) {
          const v = nested[k]
          if (typeof v === 'number' && Number.isFinite(v)) return v
        }
      }
    }
    return undefined
  }

  const input = find(obj, ['input_tokens', 'inputTokens', 'prompt_tokens'])
  const output = find(obj, ['output_tokens', 'outputTokens', 'completion_tokens'])
  const cacheRead = find(obj, ['cache_read_tokens', 'cached_input_tokens', 'cacheReadTokens'])
  const cacheCreation = find(obj, ['cache_creation_tokens', 'cache_write_input_tokens', 'cacheCreationTokens'])

  if (input === undefined || output === undefined) return null
  return {
    input: Math.max(0, input),
    output: Math.max(0, output),
    cacheRead: Math.max(0, cacheRead ?? 0),
    cacheCreation: Math.max(0, cacheCreation ?? 0),
  }
}

function parseSessionFile(filePath: string): ClaudeSessionRecord | null {
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
    let sessionId: string | undefined
    let projectDir: string | undefined
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

      if (typeof obj.sessionId === 'string' && !sessionId) {
        sessionId = obj.sessionId
      }
      if (typeof obj.cwd === 'string' && !projectDir) {
        projectDir = obj.cwd
      }

      const ts = parseTimestamp(obj.timestamp)
      if (ts) {
        if (firstTs === undefined || ts < firstTs) firstTs = ts
        if (lastTs === undefined || ts > lastTs) lastTs = ts
      }

      // Try to capture the model from any metadata-like record.
      if (!model && (obj.type === 'session_meta' || obj.type === 'meta')) {
        const payload = obj.payload as Record<string, unknown> | undefined
        const candidate = payload?.model ?? obj.model
        if (typeof candidate === 'string') model = candidate
      }

      // Exact usage summary, if present.
      if (
        obj.type === 'token_count' ||
        obj.type === 'usage' ||
        obj.type === 'message_token_usage'
      ) {
        const counts = readTokenCount(obj)
        if (counts) {
          hasExactTokenCounts = true
          inputTokens += counts.input
          outputTokens += counts.output
          cacheReadTokens += counts.cacheRead
          cacheCreationTokens += counts.cacheCreation
        }
        continue
      }

      if (hasExactTokenCounts) continue

      const message = obj.message as Record<string, unknown> | undefined
      if (!message) continue

      const role =
        typeof message.role === 'string' ? message.role.toLowerCase() : ''
      const text = extractText(message.content)
      if (!text.trim()) continue

      if (role === 'user') {
        inputTokens += estimateTokens(text)
        if (!firstUserMessage) firstUserMessage = text.trim()
      } else if (role === 'assistant') {
        outputTokens += estimateTokens(text)
      }
    }

    if (inputTokens === 0 && outputTokens === 0) return null

    const createdAt = firstTs ?? stat.mtimeMs
    const lastActiveAt = lastTs ?? stat.mtimeMs
    const id = sessionId ?? path.basename(filePath, '.jsonl')

    return {
      sessionId: id,
      providerId: 'claude-code',
      agentId: 'cc-impl',
      profile: inferClaudeProfile(projectDir),
      model: model ?? inferClaudeModel(),
      projectDir,
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
    const msg = error instanceof Error ? error.message : String(error)
    console.warn('[claude-session-scanner] failed to parse ' + filePath + ': ' + msg)
    return null
  }
}

function inferClaudeProfile(projectDir: string | undefined): string {
  if (!projectDir) return 'default'
  return path.basename(projectDir) || 'default'
}

function inferClaudeModel(): string {
  try {
    const settingsPath = path.join(os.homedir(), '.claude', 'settings.json')
    if (!fs.existsSync(settingsPath)) return 'unknown'
    const raw = fs.readFileSync(settingsPath, 'utf-8')
    const parsed = JSON.parse(raw) as Record<string, unknown>
    if (typeof parsed.model === 'string') return parsed.model
  } catch {
    // ignore
  }
  return 'unknown'
}

export function scanClaudeSessions(): ClaudeSessionRecord[] {
  const root = getClaudeProjectsDir()
  const files: string[] = []
  collectJsonlFiles(root, files)

  const sessions: ClaudeSessionRecord[] = []
  for (const file of files) {
    const session = parseSessionFile(file)
    if (session) sessions.push(session)
  }

  return sessions.sort((a, b) => b.createdAt - a.createdAt)
}
