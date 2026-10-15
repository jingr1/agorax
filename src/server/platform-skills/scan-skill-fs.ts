/**
 * Scan a skills root for SKILL.md trees — matches Hermes WebUI /
 * `agent.skill_utils.iter_skill_index_files` (recursive walk, not depth-2 only).
 *
 * Layouts:
 *   skills/<name>/SKILL.md
 *   skills/<category>/<name>/SKILL.md
 *   skills/<category>/<sub>/<name>/SKILL.md  (e.g. mlops/research/dspy)
 */
import * as fs from 'node:fs'
import * as path from 'node:path'
import type { PlatformSkillFile } from './types'

export type ScannedSkill = {
  name: string
  description: string
  category: string
  content: string
  files: Array<PlatformSkillFile>
  sourceDir: string
}

const PLATFORM_MARKER = '.agorax-platform-skill'

/** Mirrors hermes-agent EXCLUDED_SKILL_DIRS (+ common junk). */
const EXCLUDED_DIR_NAMES = new Set([
  '.git',
  '.github',
  '.hub',
  '.archive',
  '.curator_backups',
  '.venv',
  'venv',
  'node_modules',
  'site-packages',
  '__pycache__',
  '.tox',
  '.nox',
  '.pytest_cache',
  '.mypy_cache',
  '.ruff_cache',
  '.cache',
  'dist',
  'build',
  '_org',
  '_wisdom',
])

/** Progressive-disclosure dirs inside a skill package — never skill roots. */
const SKILL_SUPPORT_DIRS = new Set([
  'references',
  'templates',
  'assets',
  'scripts',
])

function collectSupportingFiles(skillDir: string): Array<PlatformSkillFile> {
  const files: Array<PlatformSkillFile> = []
  const walk = (dir: string, prefix: string) => {
    let entries: Array<fs.Dirent>
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      if (entry.name.startsWith('.')) continue
      if (SKILL_SUPPORT_DIRS.has(entry.name) && entry.isDirectory()) {
        // Still include support files as skill files (content), but don't
        // treat nested SKILL.md under them as separate skills (walk skips
        // them at the index level).
      }
      const full = path.join(dir, entry.name)
      const rel = prefix ? `${prefix}/${entry.name}` : entry.name
      if (entry.isDirectory()) {
        walk(full, rel)
        continue
      }
      if (entry.name === 'SKILL.md') continue
      try {
        files.push({ path: rel, content: fs.readFileSync(full, 'utf-8') })
      } catch {
        /* skip binary/unreadable */
      }
    }
  }
  walk(skillDir, '')
  return files
}

function readDescription(content: string): string {
  const fmMatch = content.match(/^---\r?\n([\s\S]*?)\r?\n---/)
  const block = fmMatch?.[1] ?? content.slice(0, 1024)
  const descMatch = block.match(/^description:\s*(.+?)\s*$/m)
  return descMatch?.[1]?.trim().replace(/^["']|["']$/g, '') ?? ''
}

function readName(content: string, fallback: string): string {
  const fmMatch = content.match(/^---\r?\n([\s\S]*?)\r?\n---/)
  const block = fmMatch?.[1] ?? content.slice(0, 1024)
  const nameMatch = block.match(/^name:\s*(.+?)\s*$/m)
  return nameMatch?.[1]?.trim().replace(/^["']|["']$/g, '') || fallback
}

function readCategoryFromFrontmatter(content: string): string {
  const fmMatch = content.match(/^---\r?\n([\s\S]*?)\r?\n---/)
  const block = fmMatch?.[1] ?? ''
  // metadata.hermes.category: creative  OR category: creative
  const hermesCat = block.match(
    /^\s*category:\s*(.+?)\s*$/m,
  )
  if (hermesCat) {
    return hermesCat[1].trim().replace(/^["']|["']$/g, '')
  }
  return ''
}

function titleCaseCategory(raw: string): string {
  const value = raw.trim().replace(/^\.+/, '')
  if (!value || value === '.' || value === 'General') return 'General'
  return value
    .split(/[-_/]/)
    .map((word) =>
      word.length > 0 ? word.charAt(0).toUpperCase() + word.slice(1) : '',
    )
    .filter(Boolean)
    .join(' ')
}

/**
 * Category from relative path of SKILL.md under the skills root.
 * Mirrors WebUI `_skill_category_from_path`: first path segment when nested.
 */
function categoryFromRelPath(relParts: Array<string>, content: string): string {
  const fmCat = readCategoryFromFrontmatter(content)
  // Path parts include SKILL.md as last element.
  const dirs = relParts.slice(0, -1)
  if (dirs.length >= 2) {
    return titleCaseCategory(dirs[0])
  }
  if (fmCat) return titleCaseCategory(fmCat)
  return 'General'
}

function readSkillDir(
  skillDir: string,
  categoryRaw: string,
): ScannedSkill | null {
  const skillMd = path.join(skillDir, 'SKILL.md')
  if (!fs.existsSync(skillMd)) return null
  let content = ''
  try {
    content = fs.readFileSync(skillMd, 'utf-8')
  } catch {
    return null
  }
  const basename = path.basename(skillDir)
  return {
    name: readName(content, basename),
    description: readDescription(content),
    category: titleCaseCategory(categoryRaw),
    content,
    files: collectSupportingFiles(skillDir),
    sourceDir: skillDir,
  }
}

/**
 * Recursive SKILL.md index walk (WebUI / hermes-agent `iter_skill_index_files`).
 */
export function iterSkillMdFiles(skillsDir: string): Array<string> {
  if (!skillsDir || !fs.existsSync(skillsDir)) return []
  const matches: Array<string> = []

  const walk = (dir: string) => {
    let entries: Array<fs.Dirent>
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true })
    } catch {
      return
    }
    const hasSkillMd = entries.some(
      (e) => e.isFile() && e.name === 'SKILL.md',
    )
    for (const entry of entries) {
      if (entry.isDirectory()) {
        if (EXCLUDED_DIR_NAMES.has(entry.name)) continue
        // Allow Codex system skills (`.system`) and shared `.agents`.
        if (
          entry.name.startsWith('.') &&
          entry.name !== '.agents' &&
          entry.name !== '.system'
        ) {
          continue
        }
        // Don't descend into support dirs of a skill package.
        if (hasSkillMd && SKILL_SUPPORT_DIRS.has(entry.name)) continue
        walk(path.join(dir, entry.name))
        continue
      }
      if (entry.isFile() && entry.name === 'SKILL.md') {
        matches.push(path.join(dir, entry.name))
      }
    }
  }

  walk(skillsDir)
  return matches.sort()
}

/**
 * Walk one skills root. Skips platform-materialized trees when
 * `skipPlatformManaged` is true.
 */
export function scanSkillsRoot(
  root: string,
  opts?: { skipPlatformManaged?: boolean },
): Array<ScannedSkill> {
  if (!root || !fs.existsSync(root)) return []
  const found: Array<ScannedSkill> = []
  const seen = new Set<string>()
  const rootResolved = path.resolve(root)

  for (const skillMd of iterSkillMdFiles(root)) {
    const skillDir = path.dirname(skillMd)
    if (
      opts?.skipPlatformManaged &&
      fs.existsSync(path.join(skillDir, PLATFORM_MARKER))
    ) {
      continue
    }
    let content = ''
    try {
      content = fs.readFileSync(skillMd, 'utf-8')
    } catch {
      continue
    }
    const rel = path.relative(rootResolved, skillMd)
    const relParts = rel.split(/[/\\]/).filter(Boolean)
    // Skip SKILL.md that somehow sits at the skills root itself.
    if (relParts.length < 2) continue
    // Skip support-dir nested archives (path contains references/.../SKILL.md
    // under a parent that already has SKILL.md) — iter already prunes descent,
    // but guard path segments too.
    if (relParts.some((p) => SKILL_SUPPORT_DIRS.has(p))) continue

    const category = categoryFromRelPath(relParts, content)
    const basename = path.basename(skillDir)
    const skill: ScannedSkill = {
      name: readName(content, basename),
      description: readDescription(content),
      category,
      content,
      files: collectSupportingFiles(skillDir),
      sourceDir: skillDir,
    }
    const key = skill.name.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    found.push(skill)
  }

  return found
}

export function scanManySkillsRoots(
  roots: Array<string>,
  opts?: { skipPlatformManaged?: boolean },
): Array<ScannedSkill> {
  const byName = new Map<
    string,
    ScannedSkill & { platformManaged: boolean }
  >()
  for (const root of roots) {
    for (const skill of scanSkillsRoot(root, { skipPlatformManaged: false })) {
      const key = skill.name.toLowerCase()
      const platformManaged = fs.existsSync(
        path.join(skill.sourceDir, PLATFORM_MARKER),
      )
      if (opts?.skipPlatformManaged && platformManaged) continue
      const existing = byName.get(key)
      if (!existing || (existing.platformManaged && !platformManaged)) {
        byName.set(key, { ...skill, platformManaged })
      }
    }
  }
  return [...byName.values()]
    .map(({ platformManaged: _pm, ...skill }) => skill)
    .sort((a, b) => a.name.localeCompare(b.name))
}

/** @deprecated kept for callers that still pass category explicitly */
export function scanSkillDirForTests(
  skillDir: string,
  categoryRaw: string,
): ScannedSkill | null {
  return readSkillDir(skillDir, categoryRaw)
}
