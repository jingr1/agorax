import { describe, expect, it } from 'vitest'

import {
  extractLanguageFromClassName,
  inferLanguageFromContent,
  normalizeLanguage,
  resolveCodeBlockLanguage,
  resolveLanguage,
} from './utils'

describe('extractLanguageFromClassName', () => {
  it('returns text when className is missing', () => {
    expect(extractLanguageFromClassName()).toBe('text')
    expect(extractLanguageFromClassName('')).toBe('text')
  })

  it('extracts common language ids', () => {
    expect(extractLanguageFromClassName('language-python')).toBe('python')
    expect(extractLanguageFromClassName('hljs language-bash extra')).toBe(
      'bash',
    )
  })

  it('supports hyphen and plus language ids like webui', () => {
    expect(extractLanguageFromClassName('language-c++')).toBe('c++')
    expect(extractLanguageFromClassName('language-objective-c')).toBe(
      'objective-c',
    )
  })
})

describe('normalizeLanguage', () => {
  it('maps aliases and strips fence metadata', () => {
    expect(normalizeLanguage('py')).toBe('python')
    expect(normalizeLanguage('plaintext')).toBe('text')
    expect(normalizeLanguage('language-ts')).toBe('typescript')
    expect(normalizeLanguage('c++')).toBe('cpp')
  })
})

describe('resolveLanguage', () => {
  it('resolves bundled Prism languages', () => {
    expect(resolveLanguage('python')).toBe('python')
    expect(resolveLanguage('py')).toBe('python')
    expect(resolveLanguage('bash')).toBe('bash')
    expect(resolveLanguage('javascript')).toBe('javascript')
    expect(resolveLanguage('objective-c')).toBe('text')
  })

  it('falls back to text for unknown languages', () => {
    expect(resolveLanguage('not-a-real-language')).toBe('text')
  })
})

describe('inferLanguageFromContent', () => {
  it('detects python from LLMArgs-style config blocks', () => {
    const sample = `LLMArgs(
    model="Qwen/Qwen2.5-0.5B",
    build_config=BuildConfig.from_dict({
        "build_dir": "./model_out",
    }),
)`
    expect(inferLanguageFromContent(sample)).toBe('python')
  })

  it('does not infer language for ascii diagrams', () => {
    const sample = `+------------------+
| Application      |
+------------------+`
    expect(inferLanguageFromContent(sample)).toBe(null)
  })

  it('detects bash CLI usage blocks', () => {
    const sample = `Usage: acompile [options]

Options:
  --model_name=<string>   model name
  --onnx=<path>           ONNX model file path (required)`
    expect(inferLanguageFromContent(sample)).toBe('bash')
  })

  it('detects bash from docker and source commands', () => {
    const sample = `# 进入容器
docker exec -it allspark_env /bin/bash
source /usr/local/allspark/allspark/allspark_env.sh`
    expect(inferLanguageFromContent(sample)).toBe('bash')
  })
})

describe('resolveCodeBlockLanguage', () => {
  it('prefers fence tag over inference', () => {
    expect(resolveCodeBlockLanguage('bash', 'LLMArgs()')).toBe('bash')
  })

  it('infers python when fence is unlabeled', () => {
    expect(resolveCodeBlockLanguage('text', 'def main():\n  pass')).toBe(
      'python',
    )
  })

  it('infers bash for CLI usage output without fence tag', () => {
    expect(
      resolveCodeBlockLanguage(
        'text',
        'Usage: acompile [options]\n\n  --onnx=<path>',
      ),
    ).toBe('bash')
  })
})
