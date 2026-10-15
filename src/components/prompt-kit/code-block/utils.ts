/** Languages with Prism grammars loaded in `prism-highlight.ts`. */
const HIGHLIGHT_LANGUAGES = new Set([
  'bash',
  'shell',
  'python',
  'javascript',
  'typescript',
  'json',
  'yaml',
  'markdown',
])

/** Maps common fence / editor language ids to bundled language ids. */
const LANGUAGE_ALIASES: Record<string, string> = {
  js: 'javascript',
  ts: 'typescript',
  tsx: 'typescript',
  jsx: 'javascript',
  typescriptreact: 'typescript',
  javascriptreact: 'javascript',
  react: 'javascript',
  sh: 'bash',
  shell: 'shell',
  zsh: 'bash',
  yml: 'yaml',
  md: 'markdown',
  mdx: 'markdown',
  txt: 'text',
  plain: 'text',
  plaintext: 'text',
  none: 'text',
  py: 'python',
  rb: 'ruby',
  rs: 'rust',
  cs: 'csharp',
  'c#': 'csharp',
  'c++': 'cpp',
  cc: 'cpp',
  hpp: 'cpp',
  h: 'c',
  diff: 'diff',
  patch: 'diff',
}

/**
 * Extract a language id from a `language-*` CSS class on fenced code blocks.
 * Aligns with webui fence parsing (`\w[\w+-]*`) so ids like `c++` and
 * `objective-c` are not truncated.
 */
export function extractLanguageFromClassName(
  className?: string | null | Array<string>,
): string {
  if (!className) return 'text'
  const raw = Array.isArray(className)
    ? className.filter(Boolean).join(' ')
    : String(className)
  const match = raw.match(/(?:^|\s)language-([\w+-]+)/i)
  return match?.[1]?.toLowerCase() ?? 'text'
}

export function normalizeLanguage(language: string): string {
  const cleaned = language
    .trim()
    .toLowerCase()
    .replace(/^language-/, '')
    .replace(/^\[|\]$/g, '')
  const token = cleaned.split(/[\s,{]+/)[0] || 'text'
  return LANGUAGE_ALIASES[token] ?? token
}

export function resolveLanguage(language: string): string {
  const normalized = normalizeLanguage(language)
  if (HIGHLIGHT_LANGUAGES.has(normalized)) return normalized
  const alias = LANGUAGE_ALIASES[normalized]
  if (alias && HIGHLIGHT_LANGUAGES.has(alias)) return alias
  return 'text'
}

function looksLikeAsciiDiagram(sample: string): boolean {
  const lines = sample.split('\n').slice(0, 40)
  if (lines.length < 3) return false
  const boxLines = lines.filter(
    (line) =>
      line.trim().length > 2 &&
      /^[\s|+\-/\\=_`.:*#]+$/.test(line) &&
      /[|+\-/\\]/.test(line),
  )
  return boxLines.length >= 3 && boxLines.length / lines.length >= 0.35
}

/**
 * Best-effort language guess for unlabeled fences (``` without info string).
 * Chat models often omit fence tags even when WebUI/file sources include them.
 */
export function inferLanguageFromContent(content: string): string | null {
  const sample = content.slice(0, 4000).trim()
  if (sample.length < 8 || looksLikeAsciiDiagram(sample)) return null

  if (
    /(?:^|\n)\s*(?:from|import|def|class|async def|@)\s+\w/m.test(sample) ||
    /\b(?:True|False|None)\b/.test(sample) ||
    /\b[\w.]+\.from_dict\s*\(/.test(sample) ||
    /\bLLMArgs\s*\(/.test(sample) ||
    (/(?:^|\n)\s*[\w_]+\s*=\s*[\w.]+\(/.test(sample) && /#/.test(sample))
  ) {
    return 'python'
  }

  if (
    /(?:^|\n)\s*#!\/(?:usr\/)?bin\/(?:ba)?sh/m.test(sample) ||
    /(?:^|\n)\s*(?:export|source|curl|apt-get|docker|ollama|acompile)\b/m.test(
      sample,
    ) ||
    /\/bin\/bash\b/.test(sample) ||
    (/^Usage:\s+\S+/m.test(sample) &&
      /(?:^|\n)\s*--[\w-]+(?:=|<|\s)/m.test(sample))
  ) {
    return 'bash'
  }

  if (/^\s*[\[{]/.test(sample) && /"[\w-]+"\s*:/.test(sample)) {
    return 'json'
  }

  if (
    /(?:^|\n)\s*(?:const|let|var|function|interface|type|import)\s/m.test(
      sample,
    )
  ) {
    return 'javascript'
  }

  if (/(?:^|\n)\s*#include\s+[<"]/.test(sample)) {
    return 'cpp'
  }

  return null
}

/** Combine fence tag (if any) with content heuristics for CodeBlock rendering. */
export function resolveCodeBlockLanguage(
  fenceLanguage: string | undefined,
  content: string,
): string {
  const fromFence = normalizeLanguage(fenceLanguage || 'text')
  if (fromFence !== 'text') return fromFence
  const inferred = inferLanguageFromContent(content)
  return inferred ? normalizeLanguage(inferred) : 'text'
}

export function formatLanguageName(language: string): string {
  const names: Record<string, string> = {
    bash: 'Bash',
    shell: 'Shell',
    python: 'Python',
    javascript: 'JavaScript',
    typescript: 'TypeScript',
    tsx: 'TSX',
    jsx: 'JSX',
    json: 'JSON',
    html: 'HTML',
    css: 'CSS',
    sql: 'SQL',
    yaml: 'YAML',
    markdown: 'Markdown',
    cpp: 'C++',
    c: 'C',
    rust: 'Rust',
    go: 'Go',
    diff: 'Diff',
    text: 'Plain Text',
  }
  return names[language] || language.charAt(0).toUpperCase() + language.slice(1)
}
