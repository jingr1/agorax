import { describe, expect, it } from 'vitest'
import {
  extractTranscriptionText,
  parseEnvText,
  resolveHermesAgentPython,
  resolveTranscriptionTarget,
} from './stt-transcription'

describe('stt transcription helpers', () => {
  it('parses quoted env values', () => {
    expect(parseEnvText("GROQ_API_KEY='abc123'\nOPENAI_API_KEY=xyz\n")).toEqual(
      {
        GROQ_API_KEY: 'abc123',
        OPENAI_API_KEY: 'xyz',
      },
    )
  })

  it('resolves Groq transcription settings from config and hermes env', () => {
    const result = resolveTranscriptionTarget(
      {
        stt: {
          provider: 'groq',
          language: 'fr',
          groq: { model: 'whisper-large-v3' },
        },
      },
      {},
      { GROQ_API_KEY: 'groq-secret' },
    )

    expect(result).toEqual({
      ok: true,
      kind: 'remote',
      provider: 'groq',
      model: 'whisper-large-v3',
      language: 'fr',
      apiKey: 'groq-secret',
      baseUrl: 'https://api.groq.com/openai/v1',
    })
  })

  it('resolves local transcription when Hermes python is available', () => {
    const pythonPath = resolveHermesAgentPython(
      process.env.HERMES_HOME || `${process.env.HOME}/.hermes`,
    )
    if (!pythonPath) {
      return
    }

    const result = resolveTranscriptionTarget(
      {
        stt: {
          provider: 'local',
          local: { model: 'base', language: 'zh' },
        },
      },
      { HERMES_HOME: process.env.HERMES_HOME || `${process.env.HOME}/.hermes` },
      {},
    )

    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.kind).toBe('local')
      expect(result.provider).toBe('local')
      expect(result.model).toBe('base')
      expect(result.language).toBe('zh')
      expect(result.pythonPath).toBe(pythonPath)
    }
  })

  it('returns an actionable error when Groq is configured without a key', () => {
    expect(
      resolveTranscriptionTarget({ stt: { provider: 'groq' } }, {}, {}),
    ).toEqual({
      ok: false,
      error: 'Groq STT is configured but GROQ_API_KEY is missing.',
    })
  })

  it('extracts text from OpenAI and choice-based transcription payloads', () => {
    expect(extractTranscriptionText({ text: 'bonjour' })).toBe('bonjour')
    expect(extractTranscriptionText({ transcript: 'nihao' })).toBe('nihao')
    expect(
      extractTranscriptionText({
        choices: [{ message: { content: 'hola' } }],
      }),
    ).toBe('hola')
  })
})
