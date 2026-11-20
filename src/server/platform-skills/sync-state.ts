import { createCollabId } from '../collab-db'
import { withPlatformSkillDb } from './store'
import { platformSkillTarget } from './runtime-target'
import type { SkillDeploymentResult } from './reconcile'

export function listSkillDeployments(
  skillId: string,
): Array<SkillDeploymentResult & { checkedAt: number; revisionId?: string }> {
  return withPlatformSkillDb((db) =>
    db
      .prepare(
        'SELECT * FROM skill_deployments WHERE skill_id = ? ORDER BY agent_id',
      )
      .all(skillId)
      .map((row) => ({
        agentId: String(row.agent_id),
        skillId,
        name: '',
        status: String(row.status) as SkillDeploymentResult['status'],
        path: String(row.path),
        message: row.message ? String(row.message) : undefined,
        hash: row.observed_hash ? String(row.observed_hash) : undefined,
        revisionId: row.revision_id ? String(row.revision_id) : undefined,
        checkedAt: Number(row.checked_at),
        actualMode:
          row.actual_mode === 'symlink'
            ? ('symlink' as const)
            : row.actual_mode === 'copy'
              ? ('copy' as const)
              : undefined,
        sourcePath: row.source_path ? String(row.source_path) : undefined,
        delivery:
          platformSkillTarget(String(row.agent_id)).runtime === 'hermes'
            ? ('native' as const)
            : ('on-demand' as const),
      })),
  )
}

export function withSkillSyncOperation(
  skillId: string,
  run: () => Array<SkillDeploymentResult>,
): Array<SkillDeploymentResult> {
  const owner = createCollabId('sync')
  const acquired = withPlatformSkillDb((db) => {
    const lease = db
      .prepare(
        'SELECT owner, expires_at FROM skill_sync_leases WHERE resource = ?',
      )
      .get(skillId)
    if (lease && Number(lease.expires_at) > Date.now()) return false
    db.prepare(
      'INSERT OR REPLACE INTO skill_sync_leases (resource, owner, expires_at) VALUES (?, ?, ?)',
    ).run(skillId, owner, Date.now() + 60_000)
    db.prepare(
      "INSERT INTO skill_sync_operations (id, skill_id, state, created_at, updated_at) VALUES (?, ?, 'running', ?, ?)",
    ).run(owner, skillId, Date.now(), Date.now())
    return true
  })
  if (!acquired)
    return [
      {
        agentId: '',
        skillId,
        name: '',
        status: 'pending',
        message: 'Another synchronization is running',
      },
    ]
  try {
    const results = run()
    withPlatformSkillDb((db) => {
      const current = db
        .prepare('SELECT revision_id FROM platform_skills WHERE id = ?')
        .get(skillId)
      for (const result of results) {
        db.prepare(
          `INSERT INTO skill_deployments (skill_id, agent_id, path, status, observed_hash, revision_id, message, checked_at, actual_mode, source_path)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(skill_id, agent_id) DO UPDATE SET
          path=excluded.path, status=excluded.status, observed_hash=excluded.observed_hash,
          revision_id=excluded.revision_id, message=excluded.message, checked_at=excluded.checked_at,
          actual_mode=excluded.actual_mode, source_path=excluded.source_path`,
        ).run(
          skillId,
          result.agentId,
          result.path ?? '',
          result.status,
          result.hash ?? null,
          result.status === 'in-sync' ? (current?.revision_id ?? null) : null,
          result.message ?? null,
          Date.now(),
          result.actualMode ?? null,
          result.sourcePath ?? null,
        )
      }
      db.prepare(
        'UPDATE skill_sync_operations SET state = ?, results_json = ?, updated_at = ? WHERE id = ?',
      ).run(
        results.some((result) => ['error', 'conflict'].includes(result.status))
          ? 'attention'
          : 'completed',
        JSON.stringify(results),
        Date.now(),
        owner,
      )
    })
    return results
  } catch (error) {
    withPlatformSkillDb((db) =>
      db
        .prepare(
          "UPDATE skill_sync_operations SET state = 'failed', results_json = ?, updated_at = ? WHERE id = ?",
        )
        .run(JSON.stringify({ error: String(error) }), Date.now(), owner),
    )
    throw error
  } finally {
    withPlatformSkillDb((db) =>
      db
        .prepare(
          'DELETE FROM skill_sync_leases WHERE resource = ? AND owner = ?',
        )
        .run(skillId, owner),
    )
  }
}
