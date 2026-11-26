import * as fs from 'node:fs'
import * as path from 'node:path'

/** Per-skill ignore list (gitignore-like subset). Stays on disk; not a package file. */
export const SKILL_IGNORE_FILE = '.agorax-skill-ignore'

/**
 * Load ignore patterns from `<skillRoot>/.agorax-skill-ignore`.
 * Blank lines and `#` comments are skipped. Patterns are relative to the skill root.
 */
export function loadSkillIgnorePatterns(skillRoot: string): Array<string> {
  const file = path.join(skillRoot, SKILL_IGNORE_FILE)
  if (!fs.existsSync(file) || !fs.statSync(file).isFile()) return []
  try {
    return fs
      .readFileSync(file, 'utf8')
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line.length > 0 && !line.startsWith('#'))
  } catch {
    return []
  }
}

/**
 * True when `relative` (posix path under the skill root) matches a pattern.
 *
 * Supported:
 * - `path` / `path/` — exact path or anything under that directory
 * - `path/**` — same as `path/` (directory tree)
 * - `*` / `**` inside a pattern — simple glob (`*` = one segment, `**` = any depth)
 */
export function isIgnoredSkillRelativePath(
  relative: string,
  patterns: Array<string>,
): boolean {
  const target = normalizeRelative(relative)
  if (target === SKILL_IGNORE_FILE) return true
  if (!target) return false
  for (const pattern of patterns) {
    if (matchesIgnorePattern(target, normalizeRelative(pattern))) return true
  }
  return false
}

function normalizeRelative(raw: string): string {
  return raw.replace(/\\/g, '/').replace(/^\/+/, '').replace(/\/+$/, '')
}

function matchesIgnorePattern(target: string, pattern: string): boolean {
  if (!pattern) return false
  // `foo/**` and `foo/` → ignore the directory tree.
  const directoryTree =
    pattern.endsWith('/**') ? pattern.slice(0, -3) : pattern.endsWith('/') ? pattern.slice(0, -1) : null
  if (directoryTree !== null) {
    const prefix = normalizeRelative(directoryTree)
    if (!prefix) return true
    return target === prefix || target.startsWith(`${prefix}/`)
  }
  if (!pattern.includes('*')) {
    return target === pattern || target.startsWith(`${pattern}/`)
  }
  return globToRegExp(pattern).test(target)
}

function globToRegExp(pattern: string): RegExp {
  let source = '^'
  const chars = [...pattern]
  for (let i = 0; i < chars.length; i += 1) {
    const ch = chars[i]
    if (ch === '*' && chars[i + 1] === '*') {
      source += '.*'
      i += 1
      if (chars[i + 1] === '/') i += 1
      continue
    }
    if (ch === '*') {
      source += '[^/]*'
      continue
    }
    if (/[.+^${}()|[\]\\]/.test(ch)) source += `\\${ch}`
    else source += ch
  }
  source += '(?:/.*)?$'
  return new RegExp(source)
}
