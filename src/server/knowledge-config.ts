import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { getStateDir } from './workspace-state-dir'

export type KnowledgeBaseSource =
  | { type: 'local'; path: string }
  | { type: 'github'; repo: string; branch: string; path: string }

export type KnowledgeBaseConfig = {
  source: KnowledgeBaseSource
}

/** Display / config default — aligned with llm-wiki `WIKI_PATH` (AGENTS.md). */
export const DEFAULT_WIKI_PATH = '~/wiki'

const DEFAULT_CONFIG: KnowledgeBaseConfig = {
  source: { type: 'local', path: DEFAULT_WIKI_PATH },
}

/** Resolve the default local wiki root (`WIKI_PATH` → `KNOWLEDGE_DIR` → `~/wiki`). */
export function resolveDefaultWikiRoot(): string {
  const fromEnv = process.env.WIKI_PATH?.trim() || process.env.KNOWLEDGE_DIR?.trim()
  if (fromEnv) {
    return path.resolve(fromEnv.replace(/^~\//, `${os.homedir()}/`))
  }
  return path.join(os.homedir(), 'wiki')
}

/** User-facing path label for empty states / settings. */
export function getKnowledgeRootDisplayPath(): string {
  const config = readKnowledgeBaseConfig()
  if (config.source.type === 'github') {
    const sub = config.source.path?.trim()
    return sub
      ? `${config.source.repo}/${sub}@${config.source.branch || 'main'}`
      : `${config.source.repo}@${config.source.branch || 'main'}`
  }
  const p = config.source.path.trim()
  if (p) return p
  return process.env.WIKI_PATH?.trim() || process.env.KNOWLEDGE_DIR?.trim() || DEFAULT_WIKI_PATH
}

function getConfigPath(): string {
  return path.join(getStateDir(), 'knowledge-config.json')
}

function normalizeSource(source: KnowledgeBaseSource): KnowledgeBaseSource {
  if (source.type === 'local' && !source.path.trim()) {
    return { type: 'local', path: DEFAULT_WIKI_PATH }
  }
  return source
}

export function readKnowledgeBaseConfig(): KnowledgeBaseConfig {
  const configPath = getConfigPath()
  try {
    if (fs.existsSync(configPath)) {
      const raw = fs.readFileSync(configPath, 'utf-8')
      const parsed = JSON.parse(raw) as Partial<KnowledgeBaseConfig>
      return {
        source: normalizeSource(parsed.source ?? DEFAULT_CONFIG.source),
      }
    }
  } catch {
    // ignore parse errors, use default
  }
  return DEFAULT_CONFIG
}

export function writeKnowledgeBaseConfig(config: KnowledgeBaseConfig): void {
  const configPath = getConfigPath()
  const dir = path.dirname(configPath)
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true })
  }
  fs.writeFileSync(configPath, JSON.stringify(config, null, 2), 'utf-8')
}

export function getKnowledgeBaseEffectiveRoot(): string {
  const config = readKnowledgeBaseConfig()
  if (config.source.type === 'local') {
    const p = config.source.path.trim()
    if (p) return path.resolve(p.replace(/^~\//, `${os.homedir()}/`))
  }
  return resolveDefaultWikiRoot()
}
