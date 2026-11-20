/**
 * Fetch a published skill from GitHub / ClawHub / Skills.sh / raw SKILL.md URL.
 */
import { lookup } from 'node:dns/promises'
import { normalizeSkillBundle, parseSkillFrontmatter } from './skill-bundle'
import { encodeSkillFile } from './skill-tree'
import type { SkillBundle } from './skill-bundle'
import type { PlatformSkillFile } from './types'

const FETCH_TIMEOUT_MS = 30_000
const CLAW_HUB_API = 'https://clawhub.ai/api/v1'

async function fetchText(url: string, init?: RequestInit): Promise<string> {
  return (await fetchBytes(url, init)).toString('utf8')
}

async function fetchBytes(
  url: string,
  init?: RequestInit,
  redirects = 0,
): Promise<Buffer> {
  if (redirects > 5) throw new Error('Too many import redirects')
  const parsed = new URL(url)
  if (parsed.protocol !== 'https:' || parsed.username || parsed.password)
    throw new Error('Skill imports require a public HTTPS URL')
  const addresses = await lookup(parsed.hostname, { all: true })
  if (
    !addresses.length ||
    addresses.some(({ address }) => {
      const normalized = address.toLowerCase()
      if (normalized.includes(':'))
        return (
          normalized === '::' ||
          normalized === '::1' ||
          /^(fc|fd|fe[89ab]|::ffff:)/.test(normalized)
        )
      const [first, second] = normalized.split('.').map(Number)
      return (
        first === 0 ||
        first === 10 ||
        first === 127 ||
        first >= 224 ||
        (first === 169 && second === 254) ||
        (first === 172 && second >= 16 && second <= 31) ||
        (first === 192 && second === 168) ||
        (first === 100 && second >= 64 && second <= 127)
      )
    })
  )
    throw new Error('Private network skill import URLs are not allowed')
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS)
  try {
    const response = await fetch(url, {
      ...init,
      signal: controller.signal,
      headers: {
        Accept: 'application/json, text/plain, */*',
        'User-Agent': 'Agorax-PlatformSkills/1.0',
        ...(init?.headers ?? {}),
      },
      redirect: 'manual',
    })
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      const location = response.headers.get('location')
      await response.body?.cancel()
      if (!location) throw new Error('Import redirect is missing a location')
      return fetchBytes(new URL(location, url).href, init, redirects + 1)
    }
    if (!response.ok) {
      throw new Error(`HTTP ${response.status} fetching ${url}`)
    }
    const reader = response.body?.getReader()
    if (!reader) throw new Error('Empty import response')
    const chunks: Array<Buffer> = []
    let bytes = 0
    for (;;) {
      const chunk = await reader.read()
      if (chunk.done) break
      bytes += chunk.value.length
      if (bytes > 8 * 1024 * 1024) {
        await reader.cancel()
        throw new Error('Skill download exceeds size limit')
      }
      chunks.push(Buffer.from(chunk.value))
    }
    return Buffer.concat(chunks)
  } finally {
    clearTimeout(timer)
  }
}

async function fetchJson<T>(url: string): Promise<T> {
  const text = await fetchText(url)
  return JSON.parse(text) as T
}

function ensureHttps(raw: string): string {
  const trimmed = raw.trim()
  if (!trimmed) throw new Error('URL is required')
  if (/^https?:\/\//i.test(trimmed)) return trimmed
  return `https://${trimmed}`
}

type GithubSpec = {
  owner: string
  repo: string
  ref: string
  dirPath: string
}

function parseGithubUrl(raw: string): GithubSpec | null {
  let url: URL
  try {
    url = new URL(ensureHttps(raw))
  } catch {
    return null
  }
  if (url.hostname !== 'github.com' && url.hostname !== 'www.github.com') {
    return null
  }
  const parts = url.pathname.split('/').filter(Boolean)
  if (parts.length < 2) return null
  const owner = parts[0]
  const repo = parts[1].replace(/\.git$/, '')
  if (parts.length === 2) {
    return { owner, repo, ref: '', dirPath: '' }
  }
  const kind = parts[2]
  if (kind !== 'tree' && kind !== 'blob') {
    return null
  }
  const rest = parts.slice(3)
  if (rest.length === 0) {
    return { owner, repo, ref: '', dirPath: '' }
  }
  // Ambiguous ref: try first segment as ref; callers fall back.
  const ref = rest[0]
  let pathParts = rest.slice(1)
  if (kind === 'blob' && pathParts.length > 0) {
    const last = pathParts[pathParts.length - 1]
    if (/^skill\.md$/i.test(last)) {
      pathParts = pathParts.slice(0, -1)
    }
  }
  return {
    owner,
    repo,
    ref,
    dirPath: pathParts.join('/'),
  }
}

async function resolveGithubRef(
  owner: string,
  repo: string,
  preferred: string,
): Promise<string> {
  if (preferred) {
    const commit = await fetchJson<{ sha: string }>(
      `https://api.github.com/repos/${owner}/${repo}/commits/${encodeURIComponent(preferred)}`,
    )
    return commit.sha
  }
  const info = await fetchJson<{ default_branch: string }>(
    `https://api.github.com/repos/${owner}/${repo}`,
  )
  const commit = await fetchJson<{ sha: string }>(
    `https://api.github.com/repos/${owner}/${repo}/commits/${encodeURIComponent(info.default_branch)}`,
  )
  return commit.sha
}

async function fetchGithubSkill(spec: GithubSpec): Promise<SkillBundle> {
  const ref = await resolveGithubRef(spec.owner, spec.repo, spec.ref)
  const dir = spec.dirPath.replace(/^\/+|\/+$/g, '')
  const tree = await fetchJson<{
    sha: string
    truncated?: boolean
    tree: Array<{ path: string; type: string; mode: string }>
  }>(
    `https://api.github.com/repos/${spec.owner}/${spec.repo}/git/trees/${encodeURIComponent(ref)}?recursive=1`,
  )
  if (tree.truncated)
    throw new Error(
      'Repository tree is incomplete; import a smaller skill source',
    )
  const entries = tree.tree.filter(
    (entry) =>
      entry.type === 'blob' && (!dir || entry.path.startsWith(`${dir}/`)),
  )
  if (entries.length > 256)
    throw new Error('Skill has too many files; select one skill directory')
  const files: Array<PlatformSkillFile> = []
  let total = 0
  for (const entry of entries) {
    if (entry.mode === '120000')
      throw new Error('Skill source contains a symbolic link')
    const bytes = await fetchBytes(
      `https://raw.githubusercontent.com/${spec.owner}/${spec.repo}/${ref}/${entry.path}`,
    )
    total += bytes.length
    if (total > 8 * 1024 * 1024) throw new Error('Skill package is too large')
    files.push(
      encodeSkillFile(
        dir ? entry.path.slice(dir.length + 1) : entry.path,
        bytes,
        entry.mode === '100755',
      ),
    )
  }
  return {
    ...normalizeSkillBundle(files, dir.split('/').pop() || spec.repo),
    resolvedCommit: ref,
    sourcePath: dir,
    sourceRef: spec.ref,
  }
}

async function fetchClawHubSkill(rawUrl: string): Promise<SkillBundle> {
  const url = new URL(ensureHttps(rawUrl))
  const parts = url.pathname.split('/').filter(Boolean)
  const slug = parts[parts.length - 1]
  if (!slug) throw new Error('Missing ClawHub skill slug')

  const detail = await fetchJson<{
    skill?: {
      displayName?: string
      summary?: string
      tags?: Record<string, string>
    }
    latestVersion?: { version?: string }
  }>(`${CLAW_HUB_API}/skills/${encodeURIComponent(slug)}`)

  const skill = detail.skill ?? {}
  const version = skill.tags?.latest || detail.latestVersion?.version || ''
  let filePaths: Array<string> = ['SKILL.md']
  if (version) {
    try {
      const vDetail = await fetchJson<{
        version?: { files?: Array<{ path?: string }> }
      }>(
        `${CLAW_HUB_API}/skills/${encodeURIComponent(slug)}/versions/${encodeURIComponent(version)}`,
      )
      const paths = (vDetail.version?.files ?? [])
        .map((f) => f.path)
        .filter((p): p is string => Boolean(p))
      if (paths.length > 0) filePaths = paths
    } catch {
      /* keep SKILL.md only */
    }
  }

  const files: Array<PlatformSkillFile> = []
  for (const fp of filePaths) {
    let fileUrl = `${CLAW_HUB_API}/skills/${encodeURIComponent(slug)}/file?path=${encodeURIComponent(fp)}`
    if (version) fileUrl += `&version=${encodeURIComponent(version)}`
    try {
      const content = await fetchText(fileUrl)
      files.push({ path: fp, content })
    } catch {
      /* skip missing */
    }
  }
  if (!files.some((f) => /skill\.md$/i.test(f.path))) {
    throw new Error(`SKILL.md not found on ClawHub for ${slug}`)
  }
  return normalizeSkillBundle(files, skill.displayName || slug)
}

async function fetchSkillsSh(rawUrl: string): Promise<SkillBundle> {
  // skills.sh pages often link to GitHub; try HTML scrape for github.com href.
  const html = await fetchText(ensureHttps(rawUrl))
  const match = html.match(
    /https?:\/\/(?:www\.)?github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+(?:\/(?:tree|blob)\/[^\s"'<>]+)?/,
  )
  if (match) {
    const gh = parseGithubUrl(match[0])
    if (gh) return fetchGithubSkill(gh)
  }
  throw new Error('Could not resolve Skills.sh URL to a GitHub skill directory')
}

async function fetchRawSkillMd(rawUrl: string): Promise<SkillBundle> {
  const content = await fetchText(ensureHttps(rawUrl))
  if (!/skill\.md/i.test(rawUrl) && !content.includes('---')) {
    throw new Error('URL does not look like a SKILL.md')
  }
  const fm = parseSkillFrontmatter(content)
  const base =
    ensureHttps(rawUrl)
      .split('/')
      .filter(Boolean)
      .pop()
      ?.replace(/\.md$/i, '') || 'skill'
  return {
    name: fm.name || base,
    description: fm.description,
    content,
    files: [],
  }
}

export async function fetchSkillFromUrl(rawUrl: string): Promise<{
  bundle: SkillBundle
  sourceUrl: string
}> {
  const sourceUrl = ensureHttps(rawUrl)
  let host: string
  try {
    host = new URL(sourceUrl).hostname.toLowerCase()
  } catch {
    throw new Error('Invalid URL')
  }

  if (host === 'clawhub.ai' || host === 'www.clawhub.ai') {
    return { bundle: await fetchClawHubSkill(sourceUrl), sourceUrl }
  }
  if (host === 'skills.sh' || host === 'www.skills.sh') {
    return { bundle: await fetchSkillsSh(sourceUrl), sourceUrl }
  }
  const gh = parseGithubUrl(sourceUrl)
  if (gh) {
    return { bundle: await fetchGithubSkill(gh), sourceUrl }
  }
  if (
    /skill\.md(\?|$)/i.test(sourceUrl) ||
    host === 'raw.githubusercontent.com'
  ) {
    return { bundle: await fetchRawSkillMd(sourceUrl), sourceUrl }
  }
  throw new Error(
    'Unsupported source (supported: clawhub.ai, skills.sh, github.com, raw SKILL.md URL)',
  )
}
