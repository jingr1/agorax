import {
  accessSync,
  constants,
  existsSync,
  mkdtempSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawn } from 'node:child_process'

const DEFAULT_GROQ_BASE_URL = 'https://api.groq.com/openai/v1'
const DEFAULT_OPENAI_BASE_URL = 'https://api.openai.com/v1'
const DEFAULT_GROQ_MODEL = 'whisper-large-v3-turbo'
const DEFAULT_OPENAI_MODEL = 'whisper-1'
const DEFAULT_LOCAL_MODEL = 'base'

type RecordLike = Record<string, unknown>

type SupportedRemoteProvider = 'groq' | 'openai'

export type ResolvedRemoteTranscriptionTarget = {
  ok: true
  kind: 'remote'
  provider: SupportedRemoteProvider
  model: string
  language?: string
  apiKey: string
  baseUrl: string
}

export type ResolvedLocalTranscriptionTarget = {
  ok: true
  kind: 'local'
  provider: 'local'
  model: string
  language?: string
  hermesHome: string
  pythonPath: string
}

export type ResolvedTranscriptionTarget =
  | ResolvedRemoteTranscriptionTarget
  | ResolvedLocalTranscriptionTarget

export type ResolvedTranscriptionError = {
  ok: false
  error: string
}

function readString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

function readRecord(value: unknown): RecordLike {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as RecordLike)
    : {}
}

export function resolveHermesHome(
  runtimeEnv: Record<string, string | undefined> = process.env,
): string {
  return (
    readString(runtimeEnv.HERMES_HOME) ||
    readString(runtimeEnv.HERMES_HOME) ||
    join(homedir(), '.hermes')
  )
}

export function resolveHermesAgentPython(hermesHome: string): string | null {
  const candidates = [
    join(hermesHome, 'hermes-agent', 'venv', 'bin', 'python3'),
    join(hermesHome, 'hermes-agent', '.venv', 'bin', 'python3'),
  ]
  for (const candidate of candidates) {
    try {
      accessSync(candidate, constants.X_OK)
      return candidate
    } catch {
      /* try next */
    }
  }
  return null
}

export function parseEnvText(raw: string): Record<string, string> {
  const env: Record<string, string> = {}
  for (const line of raw.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('#')) continue
    const eqIndex = trimmed.indexOf('=')
    if (eqIndex <= 0) continue
    const key = trimmed.slice(0, eqIndex).trim()
    let value = trimmed.slice(eqIndex + 1).trim()
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1)
    }
    if (key) env[key] = value
  }
  return env
}

export function readHermesEnv(
  envHome = resolveHermesHome(),
): Record<string, string> {
  const envPath = join(envHome, '.env')
  if (!existsSync(envPath)) return {}
  try {
    return parseEnvText(readFileSync(envPath, 'utf8'))
  } catch {
    return {}
  }
}

export function resolveTranscriptionTarget(
  config: RecordLike,
  runtimeEnv: Record<string, string | undefined> = process.env,
  hermesEnv: Record<string, string> = readHermesEnv(
    resolveHermesHome(runtimeEnv),
  ),
): ResolvedTranscriptionTarget | ResolvedTranscriptionError {
  const stt = readRecord(config.stt)
  const provider = readString(stt.provider) || 'local'
  const language =
    readString(stt.language) ||
    readString(readRecord(stt.local).language) ||
    undefined

  if (provider === 'local') {
    const local = readRecord(stt.local)
    const model =
      readString(local.model) ||
      readString(local.model_size) ||
      DEFAULT_LOCAL_MODEL
    const hermesHome = resolveHermesHome(runtimeEnv)
    const pythonPath = resolveHermesAgentPython(hermesHome)
    if (!pythonPath) {
      return {
        ok: false,
        error:
          'Local STT needs the Hermes Python venv (~/.hermes/hermes-agent/venv). Run `hermes doctor` to install faster-whisper.',
      }
    }
    return {
      ok: true,
      kind: 'local',
      provider: 'local',
      model,
      language,
      hermesHome,
      pythonPath,
    }
  }

  if (provider === 'groq') {
    const groq = readRecord(stt.groq)
    const apiKey =
      readString(runtimeEnv.GROQ_API_KEY) || readString(hermesEnv.GROQ_API_KEY)
    if (!apiKey) {
      return {
        ok: false,
        error: 'Groq STT is configured but GROQ_API_KEY is missing.',
      }
    }
    return {
      ok: true,
      kind: 'remote',
      provider: 'groq',
      model: readString(groq.model) || DEFAULT_GROQ_MODEL,
      language,
      apiKey,
      baseUrl:
        readString(runtimeEnv.GROQ_BASE_URL) ||
        readString(hermesEnv.GROQ_BASE_URL) ||
        DEFAULT_GROQ_BASE_URL,
    }
  }

  if (provider === 'openai') {
    const openai = readRecord(stt.openai)
    const apiKey =
      readString(runtimeEnv.VOICE_TOOLS_OPENAI_KEY) ||
      readString(hermesEnv.VOICE_TOOLS_OPENAI_KEY) ||
      readString(runtimeEnv.OPENAI_API_KEY) ||
      readString(hermesEnv.OPENAI_API_KEY)
    if (!apiKey) {
      return {
        ok: false,
        error:
          'OpenAI STT is configured but VOICE_TOOLS_OPENAI_KEY or OPENAI_API_KEY is missing.',
      }
    }
    return {
      ok: true,
      kind: 'remote',
      provider: 'openai',
      model:
        readString(openai.model) ||
        readString(runtimeEnv.STT_OPENAI_MODEL) ||
        readString(hermesEnv.STT_OPENAI_MODEL) ||
        DEFAULT_OPENAI_MODEL,
      language,
      apiKey,
      baseUrl:
        readString(runtimeEnv.STT_OPENAI_BASE_URL) ||
        readString(hermesEnv.STT_OPENAI_BASE_URL) ||
        DEFAULT_OPENAI_BASE_URL,
    }
  }

  return {
    ok: false,
    error: `Configured STT provider "${provider}" is not available through Workspace transcription.`,
  }
}

type LocalTranscriptionResult = {
  success?: boolean
  transcript?: string
  error?: string
  provider?: string
}

export async function transcribeAudioLocally(
  audioPath: string,
  target: ResolvedLocalTranscriptionTarget,
): Promise<string> {
  const agentDir = join(target.hermesHome, 'hermes-agent')
  const code = `
import json, sys
from tools.transcription_tools import transcribe_audio
result = transcribe_audio(sys.argv[1])
print(json.dumps(result))
`

  const stdout = await new Promise<string>((resolve, reject) => {
    const proc = spawn(target.pythonPath, ['-c', code, audioPath], {
      cwd: agentDir,
      env: { ...process.env, HERMES_HOME: target.hermesHome },
      stdio: ['ignore', 'pipe', 'pipe'],
    })

    let out = ''
    let err = ''
    proc.stdout.on('data', (chunk: Buffer) => {
      out += chunk.toString()
    })
    proc.stderr.on('data', (chunk: Buffer) => {
      err += chunk.toString()
    })
    proc.on('error', (error) => reject(error))
    proc.on('close', (code) => {
      if (code !== 0) {
        reject(
          new Error(
            err.trim() ||
              `Local transcription failed (exit ${code ?? 'unknown'}).`,
          ),
        )
        return
      }
      resolve(out)
    })
  })

  let parsed: LocalTranscriptionResult
  try {
    parsed = JSON.parse(stdout.trim()) as LocalTranscriptionResult
  } catch {
    throw new Error('Local transcription returned invalid JSON.')
  }

  if (!parsed.success) {
    throw new Error(parsed.error || 'Local transcription failed.')
  }

  return readString(parsed.transcript)
}

export async function transcribeUploadedAudio(
  file: File,
  target: ResolvedTranscriptionTarget,
): Promise<string> {
  if (target.kind === 'remote') {
    const upstreamForm = new FormData()
    upstreamForm.set('file', file, file.name || 'voice-input.webm')
    upstreamForm.set('model', target.model)
    if (target.language) {
      upstreamForm.set('language', target.language)
    }

    const upstream = await fetch(`${target.baseUrl}/audio/transcriptions`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${target.apiKey}`,
      },
      body: upstreamForm,
    })

    const raw = await upstream.text()
    if (!upstream.ok) {
      throw new Error(
        raw || `Transcription request failed (${upstream.status}).`,
      )
    }

    let parsed: unknown = { text: raw }
    try {
      parsed = raw ? JSON.parse(raw) : {}
    } catch {
      parsed = { text: raw }
    }

    const text = extractTranscriptionText(parsed)
    if (!text) {
      throw new Error('Transcription provider returned no text.')
    }
    return text
  }

  const extension = file.name?.includes('.')
    ? file.name.slice(file.name.lastIndexOf('.'))
    : file.type.includes('mp4')
      ? '.mp4'
      : '.webm'
  const tempDir = mkdtempSync(join(tmpdir(), 'hermes-stt-'))
  const tempPath = join(tempDir, `voice-input${extension}`)
  writeFileSync(tempPath, Buffer.from(await file.arrayBuffer()))

  try {
    return await transcribeAudioLocally(tempPath, target)
  } finally {
    try {
      unlinkSync(tempPath)
    } catch {
      /* */
    }
  }
}

export function extractTranscriptionText(payload: unknown): string {
  const record = readRecord(payload)
  const text = readString(record.text)
  if (text) return text
  const transcript = readString(record.transcript)
  if (transcript) return transcript
  const choices = Array.isArray(record.choices) ? record.choices : []
  for (const choice of choices) {
    const message = readRecord(readRecord(choice).message)
    const content = readString(message.content)
    if (content) return content
  }
  return ''
}
