/**
 * Normalize a loose file tree (folder upload or unzipped archive) into a
 * single skill: SKILL.md content + supporting files under its root.
 */
import { parse } from 'yaml'
import {
  normalizeSkillFilePath,
  skillFileBytes,
  skillTreeFiles,
} from './skill-tree'
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
  resolvedCommit?: string
  sourcePath?: string
  sourceRef?: string
}

function normalizeRelPath(raw: string): string {
  return raw
    .replace(/\\/g, '/')
    .replace(/^\.\/+/, '')
    .replace(/^\/+/, '')
}

function isIgnored(path: string): boolean {
  const parts = path.split('/')
  if (
    parts.some((p) => p === '.git' || p === 'node_modules' || p === '__MACOSX')
  ) {
    return true
  }
  const base = parts[parts.length - 1] || ''
  if (base === '.DS_Store' || base.startsWith('._')) return true
  if (base === '.agorax-platform-skill') return true
  return false
}

function isSkillMd(path: string): boolean {
  return /(?:^|\/)skill\.md$/i.test(path)
}

export function parseSkillFrontmatter(content: string): {
  name: string
  description: string
} {
  const fmMatch = content.match(/^---\r?\n([\s\S]*?)\r?\n---/)
  if (!fmMatch) return { name: '', description: '' }
  const parsed = parse(fmMatch[1]) as Record<string, unknown> | null
  return {
    name: typeof parsed?.name === 'string' ? parsed.name.trim() : '',
    description:
      typeof parsed?.description === 'string' ? parsed.description.trim() : '',
  }
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
    normalizeSkillFilePath(path)
    if (skillFileBytes(file).length > MAX_SKILL_FILE_BYTES)
      throw new Error(`Skill file is too large: ${path}`)
    normalized.push({ ...file, path, content: file.content })
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
  if (
    normalized.filter(
      (file) =>
        isSkillMd(file.path) &&
        !file.path.startsWith(`${skillPrefix}references/`) &&
        !file.path.startsWith(`${skillPrefix}templates/`),
    ).length > 1
  ) {
    throw new Error(
      'Multiple skills found; import one skill directory at a time',
    )
  }
  if (skillMd.encoding === 'base64')
    throw new Error('SKILL.md must be UTF-8 text')

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
    if (rel === 'SKILL.md') continue
    supportingCount += 1
    if (supportingCount > MAX_SKILL_FILE_COUNT) {
      throw new Error('Skill has too many files')
    }
    const bytes = skillFileBytes(file).length
    supportingBytes += bytes
    if (supportingBytes > MAX_SKILL_BUNDLE_BYTES) {
      throw new Error('Skill bundle is too large')
    }
    files.push({ ...file, path: rel })
  }

  skillTreeFiles({ content, files })
  return {
    name,
    description: fm.description,
    content,
    files,
  }
}
