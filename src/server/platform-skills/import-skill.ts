/**
 * Shared import entry points for platform skills (files / archive / URL).
 */
import { createPlatformSkill } from './store'
import { extractZipTextFiles } from './parse-zip'
import {
  MAX_SKILL_ARCHIVE_BYTES,
  normalizeSkillBundle,
  type SkillBundle,
} from './skill-bundle'
import { fetchSkillFromUrl } from './import-from-url'
import type { PlatformSkill, PlatformSkillFile, PlatformSkillOrigin } from './types'

function createFromBundle(
  bundle: SkillBundle,
  origin: PlatformSkillOrigin,
): PlatformSkill {
  return createPlatformSkill({
    name: bundle.name,
    description: bundle.description,
    content: bundle.content,
    files: bundle.files,
    origin,
  })
}

export function importSkillFromFiles(
  files: Array<PlatformSkillFile>,
  opts?: { fallbackName?: string; source?: string },
): PlatformSkill {
  const bundle = normalizeSkillBundle(files, opts?.fallbackName ?? 'skill')
  return createFromBundle(bundle, {
    kind: 'import',
    source: opts?.source ?? 'local-files',
    importedAt: Date.now(),
  })
}

export function importSkillFromArchive(
  archive: Buffer,
  filename?: string,
): PlatformSkill {
  if (archive.byteLength > MAX_SKILL_ARCHIVE_BYTES) {
    throw new Error('Archive exceeds 16 MiB limit')
  }
  const files = extractZipTextFiles(archive)
  const fallback =
    (filename || 'skill')
      .replace(/\\/g, '/')
      .split('/')
      .pop()
      ?.replace(/\.(zip|skill)$/i, '') || 'skill'
  return importSkillFromFiles(files, {
    fallbackName: fallback,
    source: `archive:${filename || 'upload'}`,
  })
}

export async function importSkillFromUrl(url: string): Promise<PlatformSkill> {
  const { bundle, sourceUrl } = await fetchSkillFromUrl(url)
  return createFromBundle(bundle, {
    kind: 'import',
    source: sourceUrl,
    importedAt: Date.now(),
  })
}
