/**
 * Fetch a published skill from GitHub / ClawHub / Skills.sh / raw SKILL.md URL.
 */
import {
  normalizeSkillBundle,
  parseSkillFrontmatter,
  type SkillBundle,
} from './skill-bundle'
import type { PlatformSkillFile } from './types'

const FETCH_TIMEOUT_MS = 30_000
const CLAW_HUB_API = 'https://clawhub.ai/api/v1'

async function fetchText(url: string, init?: RequestInit): Promise<string> {
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
      redirect: 'follow',
    })
    if (!response.ok) {
      throw new Error(`HTTP ${response.status} fetching ${url}`)
    }
    return await response.text()
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
    try {
      await fetchText(
        `https://api.github.com/repos/${owner}/${repo}/commits/${encodeURIComponent(preferred)}`,
        { headers: { Accept: 'application/vnd.github+json' } },
      )
      return preferred
    } catch {
      /* try default branch */
    }
  }
  try {
    const info = await fetchJson<{ default_branch?: string }>(
      `https://api.github.com/repos/${owner}/${repo}`,
    )
    return info.default_branch || 'main'
  } catch {
    return preferred || 'main'
  }
}

async function fetchGithubSkill(spec: GithubSpec): Promise<SkillBundle> {
  const ref = await resolveGithubRef(spec.owner, spec.repo, spec.ref)
  const dir = spec.dirPath.replace(/^\/+|\/+$/g, '')

  // Prefer contents API for directory listing; fall back to raw SKILL.md.
  const contentsUrl = dir
    ? `https://api.github.com/repos/${spec.owner}/${spec.repo}/contents/${dir}?ref=${encodeURIComponent(ref)}`
    : `https://api.github.com/repos/${spec.owner}/${spec.repo}/contents?ref=${encodeURIComponent(ref)}`

  try {
    const listing = await fetchJson<
      Array<{ name: string; path: string; type: string; download_url?: string | null }>
      | { message?: string }
    >(contentsUrl)
    if (Array.isArray(listing)) {
      const files: Array<PlatformSkillFile> = []
      const queue = [...listing]
      while (queue.length > 0 && files.length < 64) {
        const entry = queue.shift()!
        if (entry.type === 'dir') continue
        if (entry.type !== 'file' || !entry.download_url) continue
        if (/\.(png|jpe?g|gif|webp|pdf|zip)$/i.test(entry.name)) continue
        const content = await fetchText(entry.download_url)
        const rel = dir
          ? entry.path.replace(new RegExp(`^${dir.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}/`), '')
          : entry.path
        files.push({ path: rel || entry.name, content })
      }
      if (files.some((f) => /skill\.md$/i.test(f.path))) {
        return normalizeSkillBundle(
          files,
          dir.split('/').pop() || spec.repo,
        )
      }
    }
  } catch {
    /* fall through to raw */
  }

  const skillMdUrl = dir
    ? `https://raw.githubusercontent.com/${spec.owner}/${spec.repo}/${ref}/${dir}/SKILL.md`
    : `https://raw.githubusercontent.com/${spec.owner}/${spec.repo}/${ref}/SKILL.md`
  const content = await fetchText(skillMdUrl)
  const fm = parseSkillFrontmatter(content)
  return {
    name: fm.name || dir.split('/').pop() || spec.repo,
    description: fm.description,
    content,
    files: [],
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
  let version =
    skill.tags?.latest || detail.latestVersion?.version || ''
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
  throw new Error(
    'Could not resolve Skills.sh URL to a GitHub skill directory',
  )
}

async function fetchRawSkillMd(rawUrl: string): Promise<SkillBundle> {
  const content = await fetchText(ensureHttps(rawUrl))
  if (!/skill\.md/i.test(rawUrl) && !content.includes('---')) {
    throw new Error('URL does not look like a SKILL.md')
  }
  const fm = parseSkillFrontmatter(content)
  const base =
    ensureHttps(rawUrl).split('/').filter(Boolean).pop()?.replace(/\.md$/i, '') ||
    'skill'
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
  if (/skill\.md(\?|$)/i.test(sourceUrl) || host === 'raw.githubusercontent.com') {
    return { bundle: await fetchRawSkillMd(sourceUrl), sourceUrl }
  }
  throw new Error(
    'Unsupported source (supported: clawhub.ai, skills.sh, github.com, raw SKILL.md URL)',
  )
}
