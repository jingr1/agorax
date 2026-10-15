/**
 * Normalize a loose file tree (folder upload or unzipped archive) into a
 * single skill: SKILL.md content + supporting files under its root.
 */
import type { PlatformSkillFile } from './types'

export const MAX_SKILL_FILE_BYTES = 1 << 20
export const MAX_SKILL_BUNDLE_BYTES = 8 << 20
export const MAX_SKILL_FILE_COUNT = 256
export const MAX_SKILL_ARCHIVE_BYTES = 16 << 20

export type SkillBundle = {
  name: string
  description: string
  content: string
  files: Array<PlatformSkillFile>
}

function normalizeRelPath(raw: string): string {
  return raw
    .replace(/\\/g, '/')
    .replace(/^\.\/+/, '')
    .replace(/^\/+/, '')
}

function isIgnored(path: string): boolean {
  const parts = path.split('/')
  if (parts.some((p) => p === '.git' || p === 'node_modules' || p === '__MACOSX')) {
    return true
  }
  const base = parts[parts.length - 1] || ''
  if (base === '.DS_Store' || base.startsWith('._')) return true
  if (base === '.agorax-platform-skill') return true
  return false
}

function isSkillMd(path: string): boolean {
  return path.toLowerCase().endsWith('skill.md') && /skill\.md$/i.test(path)
}

function isLikelyBinary(path: string): boolean {
  return /\.(png|jpe?g|gif|webp|ico|pdf|zip|gz|tar|woff2?|ttf|eot|mp[34]|wav|webm|exe|dll|so|dylib|bin)$/i.test(
    path,
  )
}

export function parseSkillFrontmatter(content: string): {
  name: string
  description: string
} {
  let name = ''
  let description = ''
  const fmMatch = content.match(/^---\r?\n([\s\S]*?)\r?\n---/)
  const block = fmMatch?.[1] ?? content.slice(0, 1024)
  const nameMatch = block.match(/^name:\s*(.+?)\s*$/m)
  const descMatch = block.match(/^description:\s*(.+?)\s*$/m)
  if (nameMatch) {
    name = nameMatch[1].trim().replace(/^["']|["']$/g, '')
  }
  if (descMatch) {
    description = descMatch[1].trim().replace(/^["']|["']$/g, '')
  }
  return { name, description }
}

export function normalizeSkillBundle(
  rawFiles: Array<PlatformSkillFile>,
  fallbackName = 'skill',
): SkillBundle {
  if (rawFiles.length === 0) {
    throw new Error('Skill archive is empty')
  }

  const normalized: Array<PlatformSkillFile> = []
  for (const file of rawFiles) {
    const path = normalizeRelPath(file.path)
    if (!path || isIgnored(path)) continue
    if (Buffer.byteLength(file.content ?? '', 'utf-8') > MAX_SKILL_FILE_BYTES) {
      continue
    }
    normalized.push({ path, content: file.content ?? '' })
  }
  if (normalized.length === 0) {
    throw new Error('Skill archive is empty')
  }

  let skillMd: PlatformSkillFile | null = null
  let skillPrefix = ''
  for (const file of normalized) {
    if (!isSkillMd(file.path)) continue
    const idx = file.path.toLowerCase().lastIndexOf('skill.md')
    const prefix = file.path.slice(0, idx)
    if (!skillMd || prefix.length < skillPrefix.length) {
      skillMd = file
      skillPrefix = prefix
    }
  }
  if (!skillMd) {
    throw new Error('SKILL.md not found in archive')
  }

  const content = skillMd.content
  const fm = parseSkillFrontmatter(content)
  const wrapper =
    skillPrefix.replace(/\/+$/, '').split('/').filter(Boolean).pop() || ''
  const name = (fm.name || wrapper || fallbackName).trim()
  if (!name) throw new Error('Skill name is required')

  const files: Array<PlatformSkillFile> = []
  let supportingCount = 0
  let supportingBytes = 0
  for (const file of normalized) {
    if (skillPrefix && !file.path.startsWith(skillPrefix)) continue
    const rel = skillPrefix ? file.path.slice(skillPrefix.length) : file.path
    if (!rel || rel.endsWith('/')) continue
    if (isSkillMd(rel)) continue
    if (isLikelyBinary(rel)) continue
    supportingCount += 1
    if (supportingCount > MAX_SKILL_FILE_COUNT) {
      throw new Error('Skill has too many files')
    }
    const bytes = Buffer.byteLength(file.content, 'utf-8')
    supportingBytes += bytes
    if (supportingBytes > MAX_SKILL_BUNDLE_BYTES) {
      throw new Error('Skill bundle is too large')
    }
    files.push({ path: rel, content: file.content })
  }

  return {
    name,
    description: fm.description,
    content,
    files,
  }
}
