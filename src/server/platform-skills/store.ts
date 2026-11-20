/**
 * Platform skill catalog + agent bindings (collab.db).
 * One skill row, many agent_skills bindings — reuse without copying content.
 */
import { createCollabId, ensureCollabDb, getCollabDbPath } from '../collab-db'
import { openSqliteDatabase } from '../sqlite-helper'
import {
  hashSkillTree,
  isExcludedSkillPath,
  normalizeSkillFilePath,
  skillTreeFiles,
} from './skill-tree'
import type {
  AgentSkillBinding,
  ComposerSkillOption,
  CreatePlatformSkillInput,
  PlatformSkill,
  PlatformSkillFile,
  PlatformSkillOrigin,
  PlatformSkillSummary,
  UpdatePlatformSkillInput,
} from './types'

function dbPath(input?: { dbPath?: string }): string {
  return input?.dbPath ?? getCollabDbPath()
}

function withDb<T>(
  path: string,
  readonly: boolean,
  fn: (db: ReturnType<typeof openSqliteDatabase>) => T,
): T {
  ensureCollabDb(path)
  const db = openSqliteDatabase(path, readonly)
  try {
    if (!readonly) db.exec('PRAGMA foreign_keys = ON; BEGIN IMMEDIATE')
    const result = fn(db)
    if (!readonly) db.exec('COMMIT')
    return result
  } catch (error) {
    if (!readonly) db.exec('ROLLBACK')
    throw error
  } finally {
    db.close()
  }
}

function parseOrigin(raw: unknown): PlatformSkillOrigin {
  if (typeof raw !== 'string' || !raw.trim()) {
    return { kind: 'manual' }
  }
  try {
    const parsed = JSON.parse(raw) as unknown
    if (
      parsed &&
      typeof parsed === 'object' &&
      'kind' in parsed &&
      typeof parsed.kind === 'string'
    )
      return parsed as PlatformSkillOrigin
  } catch {
    /* ignore */
  }
  return { kind: 'manual' }
}

export function withPlatformSkillDb<T>(
  fn: Parameters<typeof withDb<T>>[2],
  input?: { dbPath?: string },
): T {
  return withDb(dbPath(input), false, fn)
}

export function listSkillRevisions(
  skillId: string,
): Array<{ id: string; createdAt: number; hash: string }> {
  return withDb(dbPath(), true, (db) =>
    db
      .prepare(
        'SELECT id, created_at, tree_hash FROM skill_revisions WHERE skill_id = ? ORDER BY created_at DESC, rowid DESC',
      )
      .all(skillId)
      .map((row) => ({
        id: String(row.id),
        createdAt: Number(row.created_at),
        hash: String(row.tree_hash),
      })),
  )
}

export function getSkillRevision(
  skillId: string,
  revisionId: string,
): PlatformSkill | null {
  return withDb(dbPath(), true, (db) => {
    const row = db
      .prepare(
        'SELECT snapshot_json FROM skill_revisions WHERE skill_id = ? AND id = ?',
      )
      .get(skillId, revisionId)
    return row ? (JSON.parse(String(row.snapshot_json)) as PlatformSkill) : null
  })
}

export function normalizeSkillName(name: string): string {
  const normalized = name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '')
  if (!/^[a-z0-9][a-z0-9._-]*$/.test(normalized))
    throw new Error('Invalid skill name')
  normalizeSkillFilePath(normalized)
  return normalized
}

function normalizeDeploymentMode(value: unknown): 'symlink' | 'copy' {
  if (value === undefined || value === 'symlink') return 'symlink'
  if (value === 'copy') return 'copy'
  throw new Error('Invalid deployment mode')
}

function mapSkillRow(
  row: Record<string, unknown>,
  files?: Array<PlatformSkillFile>,
): PlatformSkill {
  return {
    id: String(row.id),
    name: String(row.name),
    description: String(row.description ?? ''),
    category: String(row.category ?? ''),
    content: String(row.content ?? ''),
    origin: parseOrigin(row.origin_json),
    createdAt: Number(row.created_at ?? 0),
    updatedAt: Number(row.updated_at ?? 0),
    deploymentMode: row.deployment_mode === 'copy' ? 'copy' : 'symlink',
    allowCopyFallback: row.allow_copy_fallback !== 0,
    ...(row.revision_id ? { revisionId: String(row.revision_id) } : {}),
    ...(files ? { files } : {}),
  }
}

function listFilesForSkill(
  db: ReturnType<typeof openSqliteDatabase>,
  skillId: string,
): Array<PlatformSkillFile> {
  return db
    .prepare(
      'SELECT path, content, encoding, executable FROM platform_skill_files WHERE skill_id = ? ORDER BY path',
    )
    .all(skillId)
    .map((row) => ({
      path: String(row.path),
      content: String(row.content ?? ''),
      ...(row.encoding === 'base64' ? { encoding: 'base64' as const } : {}),
      ...(row.executable ? { executable: true } : {}),
    }))
}

function replaceSkillFiles(
  db: ReturnType<typeof openSqliteDatabase>,
  skillId: string,
  files: Array<PlatformSkillFile>,
): void {
  db.prepare('DELETE FROM platform_skill_files WHERE skill_id = ?').run(skillId)
  const insert = db.prepare(
    'INSERT INTO platform_skill_files (skill_id, path, content, encoding, executable) VALUES (?, ?, ?, ?, ?)',
  )
  for (const file of files) {
    if (isExcludedSkillPath(file.path)) continue
    const path = normalizeSkillFilePath(file.path)
    if (path === 'SKILL.md')
      throw new Error('SKILL.md must be edited as skill content')
    insert.run(
      skillId,
      path,
      file.content,
      file.encoding ?? 'utf8',
      file.executable ? 1 : 0,
    )
  }
}

function saveRevision(
  db: ReturnType<typeof openSqliteDatabase>,
  skillId: string,
): string {
  const row = db
    .prepare('SELECT * FROM platform_skills WHERE id = ?')
    .get(skillId)
  if (!row) throw new Error('Skill not found')
  const snapshot = mapSkillRow(row, listFilesForSkill(db, skillId))
  const hash = hashSkillTree(snapshot)
  const previous = row.revision_id
    ? db
        .prepare(
          'SELECT tree_hash, snapshot_json FROM skill_revisions WHERE id = ?',
        )
        .get(row.revision_id)
    : undefined
  if (previous?.tree_hash === hash) {
    const old = JSON.parse(String(previous.snapshot_json)) as PlatformSkill
    if (
      old.name === snapshot.name &&
      old.description === snapshot.description &&
      old.category === snapshot.category &&
      (old.deploymentMode ?? 'symlink') === snapshot.deploymentMode &&
      (old.allowCopyFallback ?? true) === snapshot.allowCopyFallback
    )
      return String(row.revision_id)
  }
  const revisionId = createCollabId('rev')
  db.prepare(
    'INSERT INTO skill_revisions (id, skill_id, parent_id, tree_hash, snapshot_json, created_at) VALUES (?, ?, ?, ?, ?, ?)',
  ).run(
    revisionId,
    skillId,
    row.revision_id ?? null,
    hash,
    JSON.stringify(snapshot),
    Date.now(),
  )
  db.prepare('UPDATE platform_skills SET revision_id = ? WHERE id = ?').run(
    revisionId,
    skillId,
  )
  return revisionId
}

export function listPlatformSkills(input?: {
  dbPath?: string
}): Array<PlatformSkillSummary> {
  return withDb(dbPath(input), true, (db) => {
    const rows = db
      .prepare(
        `SELECT s.id, s.name, s.description, s.category, s.origin_json, s.created_at, s.updated_at,
                (SELECT COUNT(*) FROM agent_skills a WHERE a.skill_id = s.id) AS bound_agent_count
         FROM platform_skills s
         ORDER BY s.name COLLATE NOCASE`,
      )
      .all()
    return rows.map((row) => ({
      id: String(row.id),
      name: String(row.name),
      description: String(row.description ?? ''),
      category: String(row.category ?? ''),
      origin: parseOrigin(row.origin_json),
      createdAt: Number(row.created_at ?? 0),
      updatedAt: Number(row.updated_at ?? 0),
      boundAgentCount: Number(row.bound_agent_count ?? 0),
    }))
  })
}

export function getPlatformSkill(
  skillId: string,
  input?: { dbPath?: string; includeFiles?: boolean },
): PlatformSkill | null {
  const id = skillId.trim()
  if (!id) return null
  return withDb(dbPath(input), true, (db) => {
    const row = db
      .prepare('SELECT * FROM platform_skills WHERE id = ? OR name = ?')
      .get(id, id)
    if (!row) return null
    const files =
      input?.includeFiles === false
        ? undefined
        : listFilesForSkill(db, String(row.id))
    return mapSkillRow(row, files)
  })
}

export function createPlatformSkill(
  body: CreatePlatformSkillInput,
  input?: { dbPath?: string },
): PlatformSkill {
  const name = normalizeSkillName(body.name)
  if (!name) throw new Error('Skill name is required')
  const now = Date.now()
  const id = (body.id?.trim() || createCollabId('skill')).slice(0, 64)
  const origin: PlatformSkillOrigin = body.origin ?? { kind: 'manual' }
  const deploymentMode = normalizeDeploymentMode(body.deploymentMode)
  skillTreeFiles({ content: body.content ?? '', files: body.files })
  return withDb(dbPath(input), false, (db) => {
    const existing = db
      .prepare('SELECT id FROM platform_skills WHERE name = ?')
      .get(name)
    if (existing) {
      throw new Error(`Skill name already exists: ${name}`)
    }
    db.prepare(
      `INSERT INTO platform_skills
        (id, name, description, category, content, origin_json, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      id,
      name,
      body.description?.trim() ?? '',
      body.category?.trim() ?? '',
      body.content ?? '',
      JSON.stringify(origin),
      now,
      now,
    )
    if (body.files?.length) {
      replaceSkillFiles(db, id, body.files)
    }
    db.prepare(
      'UPDATE platform_skills SET deployment_mode = ?, allow_copy_fallback = ? WHERE id = ?',
    ).run(deploymentMode, body.allowCopyFallback === false ? 0 : 1, id)
    saveRevision(db, id)
    const row = db.prepare('SELECT * FROM platform_skills WHERE id = ?').get(id)
    if (!row) throw new Error('Failed to create skill')
    return mapSkillRow(row, listFilesForSkill(db, id))
  })
}

export function upsertPlatformSkillByName(
  body: CreatePlatformSkillInput,
  input?: { dbPath?: string },
): { skill: PlatformSkill; created: boolean } {
  const name = normalizeSkillName(body.name)
  if (!name) throw new Error('Skill name is required')
  const existing = getPlatformSkill(name, {
    dbPath: input?.dbPath,
    includeFiles: true,
  })
  if (existing) {
    if (
      hashSkillTree(existing) !==
      hashSkillTree({ content: body.content ?? '', files: body.files })
    )
      throw new Error(`Skill source conflict: ${name}`)
    return { skill: existing, created: false }
  }
  return { skill: createPlatformSkill(body, input), created: true }
}

/** Drop junk attachments (e.g. seeded `node_modules/`) from the catalog head. */
export function pruneExcludedPlatformSkillFiles(input?: {
  dbPath?: string
}): number {
  return withDb(dbPath(input), false, (db) => {
    const rows = db
      .prepare('SELECT skill_id, path FROM platform_skill_files')
      .all() as Array<{ skill_id: unknown; path: unknown }>
    const bySkill = new Map<string, Array<string>>()
    for (const row of rows) {
      const relative = String(row.path ?? '')
      if (!isExcludedSkillPath(relative)) continue
      const skillId = String(row.skill_id)
      const list = bySkill.get(skillId) ?? []
      list.push(relative)
      bySkill.set(skillId, list)
    }
    if (bySkill.size === 0) return 0
    const remove = db.prepare(
      'DELETE FROM platform_skill_files WHERE skill_id = ? AND path = ?',
    )
    let removed = 0
    for (const [skillId, paths] of bySkill) {
      for (const relative of paths) {
        removed += remove.run(skillId, relative).changes
      }
      saveRevision(db, skillId)
    }
    return removed
  })
}

export function updatePlatformSkill(
  skillId: string,
  body: UpdatePlatformSkillInput,
  input?: { dbPath?: string },
): PlatformSkill {
  const id = skillId.trim()
  if (!id) throw new Error('skillId is required')
  return withDb(dbPath(input), false, (db) => {
    const row = db
      .prepare('SELECT * FROM platform_skills WHERE id = ? OR name = ?')
      .get(id, id)
    if (!row) throw new Error(`Skill not found: ${id}`)
    const resolvedId = String(row.id)
    if (
      body.expectedRevision !== undefined &&
      body.expectedRevision !== String(row.revision_id ?? '')
    ) {
      throw new Error('Revision conflict: reload the skill before saving')
    }
    let name = String(row.name)
    if (typeof body.name === 'string' && body.name.trim()) {
      name = normalizeSkillName(body.name)
      const clash = db
        .prepare('SELECT id FROM platform_skills WHERE name = ? AND id != ?')
        .get(name, resolvedId)
      if (clash) throw new Error(`Skill name already exists: ${name}`)
    }
    const description =
      typeof body.description === 'string'
        ? body.description.trim()
        : String(row.description ?? '')
    const category =
      typeof body.category === 'string'
        ? body.category.trim()
        : String(row.category ?? '')
    const content =
      typeof body.content === 'string'
        ? body.content
        : String(row.content ?? '')
    const origin = body.origin ?? parseOrigin(row.origin_json)
    skillTreeFiles({
      content,
      files: body.files ?? listFilesForSkill(db, resolvedId),
    })
    const now = Date.now()
    db.prepare(
      `UPDATE platform_skills
       SET name = ?, description = ?, category = ?, content = ?, origin_json = ?, updated_at = ?
       WHERE id = ?`,
    ).run(
      name,
      description,
      category,
      content,
      JSON.stringify(origin),
      now,
      resolvedId,
    )
    if (body.files) {
      replaceSkillFiles(db, resolvedId, body.files)
    }
    db.prepare(
      'UPDATE platform_skills SET deployment_mode = ?, allow_copy_fallback = ? WHERE id = ?',
    ).run(
      normalizeDeploymentMode(body.deploymentMode ?? row.deployment_mode),
      body.allowCopyFallback === undefined
        ? row.allow_copy_fallback
        : body.allowCopyFallback
          ? 1
          : 0,
      resolvedId,
    )
    saveRevision(db, resolvedId)
    const updated = db
      .prepare('SELECT * FROM platform_skills WHERE id = ?')
      .get(resolvedId)
    if (!updated) throw new Error('Skill update failed')
    return mapSkillRow(updated, listFilesForSkill(db, resolvedId))
  })
}

export function deletePlatformSkill(
  skillId: string,
  input?: { dbPath?: string },
): boolean {
  const id = skillId.trim()
  if (!id) return false
  return withDb(dbPath(input), false, (db) => {
    const row = db
      .prepare('SELECT id FROM platform_skills WHERE id = ? OR name = ?')
      .get(id, id)
    if (!row) return false
    db.prepare('DELETE FROM agent_skills WHERE skill_id = ?').run(
      String(row.id),
    )
    db.prepare('DELETE FROM platform_skill_files WHERE skill_id = ?').run(
      String(row.id),
    )
    const result = db
      .prepare('DELETE FROM platform_skills WHERE id = ?')
      .run(String(row.id))
    return result.changes > 0
  })
}

export function listAgentSkillBindings(
  agentId: string,
  input?: { dbPath?: string; enabledOnly?: boolean },
): Array<AgentSkillBinding> {
  const id = agentId.trim()
  if (!id) return []
  return withDb(dbPath(input), true, (db) => {
    const sql = input?.enabledOnly
      ? `SELECT a.agent_id, a.skill_id, a.enabled, a.created_at, s.name, s.description
         FROM agent_skills a
         JOIN platform_skills s ON s.id = a.skill_id
         WHERE a.agent_id = ? AND a.enabled = 1
         ORDER BY s.name COLLATE NOCASE`
      : `SELECT a.agent_id, a.skill_id, a.enabled, a.created_at, s.name, s.description
         FROM agent_skills a
         JOIN platform_skills s ON s.id = a.skill_id
         WHERE a.agent_id = ?
         ORDER BY s.name COLLATE NOCASE`
    return db
      .prepare(sql)
      .all(id)
      .map((row) => ({
        agentId: String(row.agent_id),
        skillId: String(row.skill_id),
        enabled: Number(row.enabled ?? 0) === 1,
        createdAt: Number(row.created_at ?? 0),
        name: String(row.name),
        description: String(row.description ?? ''),
      }))
  })
}

export function listSkillAgentBindings(
  skillId: string,
  input?: { dbPath?: string },
): Array<{ agentId: string; enabled: boolean; createdAt: number }> {
  const id = skillId.trim()
  if (!id) return []
  return withDb(dbPath(input), true, (db) => {
    const skill = db
      .prepare('SELECT id FROM platform_skills WHERE id = ? OR name = ?')
      .get(id, id)
    if (!skill) return []
    return db
      .prepare(
        `SELECT agent_id, enabled, created_at
         FROM agent_skills WHERE skill_id = ? ORDER BY agent_id`,
      )
      .all(String(skill.id))
      .map((row) => ({
        agentId: String(row.agent_id),
        enabled: Number(row.enabled ?? 0) === 1,
        createdAt: Number(row.created_at ?? 0),
      }))
  })
}

export function setAgentSkills(
  agentId: string,
  skillIds: Array<string>,
  input?: { dbPath?: string },
): Array<AgentSkillBinding> {
  const id = agentId.trim()
  if (!id) throw new Error('agentId is required')
  const unique = [...new Set(skillIds.map((s) => s.trim()).filter(Boolean))]
  withDb(dbPath(input), false, (db) => {
    const resolved: Array<string> = []
    for (const skillId of unique) {
      const row = db
        .prepare('SELECT id FROM platform_skills WHERE id = ? OR name = ?')
        .get(skillId, skillId)
      if (!row) throw new Error(`Skill not found: ${skillId}`)
      resolved.push(String(row.id))
    }
    const existing = db
      .prepare('SELECT skill_id, enabled FROM agent_skills WHERE agent_id = ?')
      .all(id)
    const enabled = new Map(
      existing.map((row) => [String(row.skill_id), Number(row.enabled)]),
    )
    for (const row of existing) {
      if (!resolved.includes(String(row.skill_id)))
        db.prepare(
          'INSERT OR IGNORE INTO agent_skill_exclusions (agent_id, skill_id) VALUES (?, ?)',
        ).run(id, row.skill_id)
    }
    db.prepare('DELETE FROM agent_skills WHERE agent_id = ?').run(id)
    const now = Date.now()
    const insert = db.prepare(
      `INSERT INTO agent_skills (agent_id, skill_id, enabled, created_at)
      VALUES (?, ?, ?, ?)`,
    )
    for (const skillId of resolved) {
      db.prepare(
        'DELETE FROM agent_skill_exclusions WHERE agent_id = ? AND skill_id = ?',
      ).run(id, skillId)
      insert.run(id, skillId, enabled.get(skillId) ?? 1, now)
    }
  })
  return listAgentSkillBindings(id, input)
}

export function addAgentSkills(
  agentId: string,
  skillIds: Array<string>,
  input?: { dbPath?: string; discovered?: boolean },
): Array<AgentSkillBinding> {
  const id = agentId.trim()
  if (!id) throw new Error('agentId is required')
  const unique = [...new Set(skillIds.map((s) => s.trim()).filter(Boolean))]
  if (unique.length === 0) return listAgentSkillBindings(id, input)
  withDb(dbPath(input), false, (db) => {
    const now = Date.now()
    const insert = db.prepare(
      `INSERT INTO agent_skills (agent_id, skill_id, enabled, created_at)
       VALUES (?, ?, 1, ?)
       ON CONFLICT(agent_id, skill_id) DO NOTHING`,
    )
    for (const skillId of unique) {
      const row = db
        .prepare('SELECT id FROM platform_skills WHERE id = ? OR name = ?')
        .get(skillId, skillId)
      if (!row) throw new Error(`Skill not found: ${skillId}`)
      if (
        input?.discovered &&
        db
          .prepare(
            'SELECT 1 FROM agent_skill_exclusions WHERE agent_id = ? AND skill_id = ?',
          )
          .get(id, row.id)
      )
        continue
      db.prepare(
        'DELETE FROM agent_skill_exclusions WHERE agent_id = ? AND skill_id = ?',
      ).run(id, row.id)
      insert.run(id, String(row.id), now)
    }
  })
  return listAgentSkillBindings(id, input)
}

export function setAgentSkillEnabled(
  agentId: string,
  skillId: string,
  enabled: boolean,
  input?: { dbPath?: string },
): AgentSkillBinding | null {
  const aid = agentId.trim()
  const sid = skillId.trim()
  if (!aid || !sid) return null
  return withDb(dbPath(input), false, (db) => {
    const skill = db
      .prepare('SELECT id FROM platform_skills WHERE id = ? OR name = ?')
      .get(sid, sid)
    if (!skill) return null
    const result = db
      .prepare(
        `UPDATE agent_skills SET enabled = ? WHERE agent_id = ? AND skill_id = ?`,
      )
      .run(enabled ? 1 : 0, aid, String(skill.id))
    if (result.changes === 0) return null
    const row = db
      .prepare(
        `SELECT a.agent_id, a.skill_id, a.enabled, a.created_at, s.name, s.description
         FROM agent_skills a
         JOIN platform_skills s ON s.id = a.skill_id
         WHERE a.agent_id = ? AND a.skill_id = ?`,
      )
      .get(aid, String(skill.id))
    if (!row) return null
    return {
      agentId: String(row.agent_id),
      skillId: String(row.skill_id),
      enabled: Number(row.enabled ?? 0) === 1,
      createdAt: Number(row.created_at ?? 0),
      name: String(row.name),
      description: String(row.description ?? ''),
    }
  })
}

export function removeAgentSkill(
  agentId: string,
  skillId: string,
  input?: { dbPath?: string },
): boolean {
  const aid = agentId.trim()
  const sid = skillId.trim()
  if (!aid || !sid) return false
  return withDb(dbPath(input), false, (db) => {
    const skill = db
      .prepare('SELECT id FROM platform_skills WHERE id = ? OR name = ?')
      .get(sid, sid)
    if (!skill) return false
    db.prepare(
      'INSERT OR IGNORE INTO agent_skill_exclusions (agent_id, skill_id) VALUES (?, ?)',
    ).run(aid, skill.id)
    const result = db
      .prepare('DELETE FROM agent_skills WHERE agent_id = ? AND skill_id = ?')
      .run(aid, String(skill.id))
    return result.changes > 0
  })
}

export function listComposerSkillsForAgent(
  agentId: string,
  input?: { dbPath?: string; includeContent?: boolean },
): Array<ComposerSkillOption> {
  const bindings = listAgentSkillBindings(agentId, {
    dbPath: input?.dbPath,
    enabledOnly: true,
  })
  if (!input?.includeContent) {
    return bindings.map((b) => ({
      id: b.skillId,
      name: b.name,
      description: b.description,
      trigger: `/${b.name}`,
    }))
  }
  return bindings.map((b) => {
    const skill = getPlatformSkill(b.skillId, {
      dbPath: input.dbPath,
      includeFiles: false,
    })
    return {
      id: b.skillId,
      name: b.name,
      description: b.description,
      trigger: `/${b.name}`,
      content: skill?.content ?? '',
    }
  })
}

export function listEnabledSkillsWithContent(
  agentId: string,
  input?: { dbPath?: string },
): Array<PlatformSkill> {
  const bindings = listAgentSkillBindings(agentId, {
    dbPath: input?.dbPath,
    enabledOnly: true,
  })
  const out: Array<PlatformSkill> = []
  for (const binding of bindings) {
    const skill = getPlatformSkill(binding.skillId, {
      dbPath: input?.dbPath,
      includeFiles: true,
    })
    if (skill) out.push(skill)
  }
  return out
}
