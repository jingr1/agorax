/** File kind helpers aligned with hermes-webui openFile branching. */

export type FilePreviewKind =
  | 'image'
  | 'audio'
  | 'video'
  | 'pdf'
  | 'markdown'
  | 'html'
  | 'csv'
  | 'code'
  | 'download'

const IMAGE_EXTS = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg'])
const AUDIO_EXTS = new Set(['mp3', 'wav', 'ogg', 'm4a', 'aac', 'flac'])
const VIDEO_EXTS = new Set(['mp4', 'webm', 'mov', 'mkv'])
const PDF_EXTS = new Set(['pdf'])
const MD_EXTS = new Set(['md', 'markdown', 'mdx'])
const HTML_EXTS = new Set(['html', 'htm'])
const CSV_EXTS = new Set(['csv', 'tsv'])
const DOWNLOAD_EXTS = new Set([
  'zip',
  'tar',
  'gz',
  'tgz',
  'bz2',
  'xz',
  '7z',
  'rar',
  'exe',
  'dmg',
  'pkg',
  'deb',
  'rpm',
  'bin',
  'wasm',
  'woff',
  'woff2',
  'ttf',
  'otf',
  'eot',
  'doc',
  'docx',
  'xls',
  'xlsx',
  'ppt',
  'pptx',
])

export const MD_PREVIEW_RICH_RENDER_MAX_BYTES = 256 * 1024
export const MD_PREVIEW_RICH_RENDER_MAX_LINES = 5000
export const CSV_MAX_PREVIEW_CHARS = 2 * 1024 * 1024

export function getFileExtension(pathValue: string): string {
  const base = pathValue.split(/[\\/]/).pop() || pathValue
  const dot = base.lastIndexOf('.')
  return dot >= 0 ? base.slice(dot + 1).toLowerCase() : ''
}

export function classifyFilePreviewKind(pathValue: string): FilePreviewKind {
  const ext = getFileExtension(pathValue)
  if (DOWNLOAD_EXTS.has(ext)) return 'download'
  if (IMAGE_EXTS.has(ext)) return 'image'
  if (AUDIO_EXTS.has(ext)) return 'audio'
  if (VIDEO_EXTS.has(ext)) return 'video'
  if (PDF_EXTS.has(ext)) return 'pdf'
  if (MD_EXTS.has(ext)) return 'markdown'
  if (HTML_EXTS.has(ext)) return 'html'
  if (CSV_EXTS.has(ext)) return 'csv'
  return 'code'
}

export function isEditablePreviewKind(kind: FilePreviewKind): boolean {
  return (
    kind === 'code' || kind === 'markdown' || kind === 'html' || kind === 'csv'
  )
}

export function shouldRenderMarkdownAsPlainText(content: string): boolean {
  const bytes = new TextEncoder().encode(content).length
  const lines = content ? content.split('\n').length : 1
  return (
    bytes > MD_PREVIEW_RICH_RENDER_MAX_BYTES ||
    lines > MD_PREVIEW_RICH_RENDER_MAX_LINES
  )
}

export function languageFromPath(pathValue: string): string {
  const ext = getFileExtension(pathValue)
  const map: Record<string, string> = {
    ts: 'typescript',
    tsx: 'tsx',
    js: 'javascript',
    jsx: 'jsx',
    json: 'json',
    py: 'python',
    rs: 'rust',
    go: 'go',
    java: 'java',
    css: 'css',
    scss: 'scss',
    html: 'html',
    htm: 'html',
    md: 'markdown',
    markdown: 'markdown',
    yml: 'yaml',
    yaml: 'yaml',
    sh: 'bash',
    bash: 'bash',
    zsh: 'bash',
    sql: 'sql',
    toml: 'toml',
    xml: 'xml',
    c: 'c',
    h: 'c',
    cpp: 'cpp',
    cc: 'cpp',
    hpp: 'cpp',
  }
  return map[ext] || 'text'
}

export type CsvTablePreview =
  | {
      ok: true
      headers: Array<string>
      rows: Array<Array<string>>
      truncated: boolean
    }
  | { ok: false; error: string }

export function buildCsvTablePreview(content: string): CsvTablePreview {
  if (typeof content !== 'string') return { ok: false, error: 'Invalid CSV' }
  if (content.length > CSV_MAX_PREVIEW_CHARS) {
    return { ok: false, error: 'CSV too large to preview' }
  }
  const lines = content
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '\n')
    .split('\n')
    .filter((row) => row.trim())
  if (lines.length < 2) return { ok: false, error: 'No tabular data' }

  const firstLine = lines[0] || ''
  const separators = [',', ';', '\t']
  const sep = separators.find((s) => firstLine.includes(s)) || ','
  const clean = (cell: string) => cell.trim().replace(/^["']|["']$/g, '')
  const headers = firstLine.split(sep).map(clean)
  const maxRows = 500
  const body = lines
    .slice(1, maxRows + 1)
    .map((line) => line.split(sep).map(clean))
  return {
    ok: true,
    headers,
    rows: body,
    truncated: lines.length - 1 > maxRows,
  }
}
