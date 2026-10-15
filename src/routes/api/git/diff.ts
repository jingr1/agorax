import { createFileRoute } from '@tanstack/react-router'
import { json } from '@tanstack/react-start'
import { isAuthenticated } from '../../../server/auth-middleware'
import { getProject } from '../../../server/task-pipeline/projects'
import { getSwarmMission } from '../../../server/swarm-missions'
import {
  diffRange as diffRangeImpl,
  localGitContext as localGitContextImpl,
} from '../../../server/git-ops'
import type { ProjectDeclaration } from '../../../server/task-pipeline/projects'
import type { SwarmMissionAssignment } from '../../../server/swarm-missions'
import type { GitContext } from '../../../server/git-ops'

type DiffRangeFn = (
  ctx: GitContext,
  base: string,
  head: string,
  filePath?: string,
) => Promise<string>

type LocalGitContextFn = (
  project: ProjectDeclaration,
  missionId: string,
) => GitContext

/**
 * GET /api/git/diff?projectId=&missionId=&base=&head=&path=
 *
 * Returns a unified diff for a project/mission commit range.
 * If base/head are omitted, uses the mission's base_ref/head_sha.
 */
export async function handleGitDiff(
  request: Request,
  deps?: {
    getProject?: (projectId: string) => ProjectDeclaration | null
    getSwarmMission?: (missionId: string) => ReturnType<typeof getSwarmMission>
    diffRange?: typeof diffRangeImpl
    localGitContext?: typeof localGitContextImpl
    isAuthenticated?: (request: Request) => boolean
  },
): Promise<Response> {
  const _isAuthenticated = deps?.isAuthenticated ?? isAuthenticated
  const _getProject = deps?.getProject ?? getProject
  const _getSwarmMission = deps?.getSwarmMission ?? getSwarmMission
  const _diffRange = deps?.diffRange ?? diffRangeImpl
  const _localGitContext = deps?.localGitContext ?? localGitContextImpl

  if (!_isAuthenticated(request))
    return json({ error: 'Unauthorized' }, { status: 401 })
  const url = new URL(request.url)
  const projectId = url.searchParams.get('projectId')
  const missionId = url.searchParams.get('missionId')
  const base = url.searchParams.get('base')
  const head = url.searchParams.get('head')
  const filePath = url.searchParams.get('path') ?? undefined

  if (!projectId) return json({ error: 'Missing projectId' }, { status: 400 })
  const project = _getProject(projectId)
  if (!project)
    return json({ error: `Unknown project: ${projectId}` }, { status: 404 })

  let baseRef = base
  let headRef = head
  if (missionId) {
    const mission = _getSwarmMission(missionId)
    if (mission) {
      if (!baseRef) {
        baseRef =
          mission.assignments.find((a: SwarmMissionAssignment) => a.baseRef)
            ?.baseRef ?? null
      }
      if (!headRef) {
        headRef =
          mission.assignments.find((a: SwarmMissionAssignment) => a.headSha)
            ?.headSha ?? null
      }
    }
  }
  if (!baseRef || !headRef) {
    return json(
      {
        error: 'Missing base and/or head, and mission has no recorded refs',
      },
      { status: 400 },
    )
  }

  try {
    const ctx = _localGitContext(project, missionId ?? 'unknown')
    const diff = await _diffRange(ctx, baseRef, headRef, filePath)
    return json({
      diff,
      base: baseRef,
      head: headRef,
      projectId,
      missionId,
    })
  } catch (error) {
    return json(
      { error: error instanceof Error ? error.message : String(error) },
      { status: 500 },
    )
  }
}

export const Route = createFileRoute('/api/git/diff')({
  server: {
    handlers: {
      GET: async ({ request }: { request: Request }) => handleGitDiff(request),
    },
  },
})
