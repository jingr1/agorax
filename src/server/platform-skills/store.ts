/**
 * Platform skill catalog + agent bindings (collab.db).
 * One skill row, many agent_skills bindings — reuse without copying content.
 */
import { ensureCollabDb, getCollabDbPath, createCollabId } from '../collab-db'
import { openSqliteDatabase } from '../sqlite-helper'
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
    return fn(db)
  } finally {
    db.close()
  }
}

function parseOrigin(raw: unknown): PlatformSkillOrigin {
  if (typeof raw !== 'string' || !raw.trim()) {
    return { kind: 'manual' }
  }
  try {
    const parsed = JSON.parse(raw) as PlatformSkillOrigin
    if (parsed && typeof parsed.kind === 'string') return parsed
  } catch {
    /* ignore */
  }
  return { kind: 'manual' }
}

function normalizeSkillName(name: string): string {
  return name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '')
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
    ...(files ? { files } : {}),
  }
}

function listFilesForSkill(
  db: ReturnType<typeof openSqliteDatabase>,
  skillId: string,
): Array<PlatformSkillFile> {
  return db
    .prepare(
      'SELECT path, content FROM platform_skill_files WHERE skill_id = ? ORDER BY path',
    )
    .all(skillId)
    .map((row) => ({
      path: String(row.path),
      content: String(row.content ?? ''),
    }))
}

function replaceSkillFiles(
  db: ReturnType<typeof openSqliteDatabase>,
  skillId: string,
  files: Array<PlatformSkillFile>,
): void {
  db.prepare('DELETE FROM platform_skill_files WHERE skill_id = ?').run(skillId)
  const insert = db.prepare(
    'INSERT INTO platform_skill_files (skill_id, path, content) VALUES (?, ?, ?)',
  )
  for (const file of files) {
    const path = file.path.trim().replace(/^\/+/, '')
    if (!path || path.includes('..') || path === 'SKILL.md') continue
    insert.run(skillId, path, file.content ?? '')
  }
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
    const updated = updatePlatformSkill(
      existing.id,
      {
        description: body.description ?? existing.description,
        category: body.category ?? existing.category,
        content: body.content ?? existing.content,
        files: body.files ?? existing.files,
        origin: body.origin ?? existing.origin,
      },
      input,
    )
    return { skill: updated, created: false }
  }
  return { skill: createPlatformSkill(body, input), created: true }
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
    let name = String(row.name)
    if (typeof body.name === 'string' && body.name.trim()) {
      name = normalizeSkillName(body.name)
      const clash = db
        .prepare(
          'SELECT id FROM platform_skills WHERE name = ? AND id != ?',
        )
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
      typeof body.content === 'string' ? body.content : String(row.content ?? '')
    const origin = body.origin ?? parseOrigin(row.origin_json)
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
    return db.prepare(sql).all(id).map((row) => ({
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
  const unique = [
    ...new Set(skillIds.map((s) => s.trim()).filter(Boolean)),
  ]
  withDb(dbPath(input), false, (db) => {
    const resolved: Array<string> = []
    for (const skillId of unique) {
      const row = db
        .prepare('SELECT id FROM platform_skills WHERE id = ? OR name = ?')
        .get(skillId, skillId)
      if (!row) throw new Error(`Skill not found: ${skillId}`)
      resolved.push(String(row.id))
    }
    db.prepare('DELETE FROM agent_skills WHERE agent_id = ?').run(id)
    const now = Date.now()
    const insert = db.prepare(
      `INSERT INTO agent_skills (agent_id, skill_id, enabled, created_at)
       VALUES (?, ?, 1, ?)`,
    )
    for (const skillId of resolved) {
      insert.run(id, skillId, now)
    }
  })
  return listAgentSkillBindings(id, input)
}

export function addAgentSkills(
  agentId: string,
  skillIds: Array<string>,
  input?: { dbPath?: string },
): Array<AgentSkillBinding> {
  const id = agentId.trim()
  if (!id) throw new Error('agentId is required')
  const unique = [
    ...new Set(skillIds.map((s) => s.trim()).filter(Boolean)),
  ]
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
    const result = db
      .prepare(
        'DELETE FROM agent_skills WHERE agent_id = ? AND skill_id = ?',
      )
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
      dbPath: input?.dbPath,
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
