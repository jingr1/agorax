/**
 * Hermes Dashboard kanban plugin proxy.
 *
 * When `caps.kanban === true` (probed in gateway-capabilities), the
 * dashboard exposes the upstream Hermes kanban plugin at
 * `/api/plugins/kanban/*`. This module is a thin HTTP proxy so the
 * workspace's `/api/swarm-kanban/*` routes can talk to the dashboard
 * without touching SQLite directly.
 *
 * Auth: newer Hermes dashboards require the ephemeral session token for
 * `/api/plugins/kanban/*`. Always route through `dashboardFetch()` from
 * gateway-capabilities (auto token + 401 retry) — do not roll a separate
 * fetch path here.
 *
 * See v2.3.0 plan.
 */
import { dashboardFetch } from './gateway-capabilities'

const PROXY_TIMEOUT_MS = 10_000

export type DashboardKanbanTask = {
  id: string
  title: string
  body?: string | null
  assignee?: string | null
  status: string
  priority?: number | null
  created_by?: string | null
  created_at?: number | null
  started_at?: number | null
  completed_at?: number | null
  workspace_kind?: string | null
  workspace_path?: string | null
}

export type DashboardKanbanBoardResponse = {
  columns: Array<{
    name: string
    tasks: Array<DashboardKanbanTask>
  }>
}

function withQuery(
  path: string,
  params: Record<string, string | undefined> = {},
): string {
  const url = new URL(path, 'http://local')
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== '') url.searchParams.set(key, value)
  }
  const qs = url.search
  return qs ? `${path.split('?')[0]}${qs}` : path
}

async function dashboardKanbanJson<T>(
  path: string,
  init: RequestInit = {},
  params: Record<string, string | undefined> = {},
): Promise<T> {
  const method = (init.method || 'GET').toUpperCase()
  const res = await dashboardFetch(withQuery(path, params), {
    ...init,
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(init.headers || {}),
    },
    signal: AbortSignal.timeout(PROXY_TIMEOUT_MS),
  })
  if (!res.ok) {
    const body = await res.text().catch(() => '')
    throw new Error(
      `Dashboard kanban proxy: ${method} ${path} → ${res.status}${body ? ` — ${body.slice(0, 200)}` : ''}`,
    )
  }
  return (await res.json()) as T
}

/** Fetch the full board (all columns + tasks) from the dashboard plugin. */
export function fetchDashboardKanbanBoard(
  board?: string,
): Promise<DashboardKanbanBoardResponse> {
  return dashboardKanbanJson<DashboardKanbanBoardResponse>(
    '/api/plugins/kanban/board',
    {},
    board ? { board } : {},
  )
}

/** Fetch one task by id. Returns null on 404. */
export async function fetchDashboardKanbanTask(
  taskId: string,
  board?: string,
): Promise<DashboardKanbanTask | null> {
  try {
    const wrapped = await dashboardKanbanJson<{ task?: DashboardKanbanTask }>(
      `/api/plugins/kanban/tasks/${encodeURIComponent(taskId)}`,
      {},
      board ? { board } : {},
    )
    return wrapped.task ?? null
  } catch (err) {
    if (err instanceof Error && err.message.includes('→ 404')) return null
    throw err
  }
}

export type CreateDashboardKanbanTaskInput = {
  title: string
  body?: string
  assignee?: string | null
  status?: string
  priority?: number
  created_by?: string
  workspace_kind?: string
  workspace_path?: string
}

/** Create a task on the dashboard board. */
export async function createDashboardKanbanTask(
  input: CreateDashboardKanbanTaskInput,
  board?: string,
): Promise<DashboardKanbanTask> {
  const wrapped = await dashboardKanbanJson<{ task: DashboardKanbanTask }>(
    '/api/plugins/kanban/tasks',
    {
      method: 'POST',
      body: JSON.stringify(input),
    },
    board ? { board } : {},
  )
  return wrapped.task
}

export type UpdateDashboardKanbanTaskInput = {
  title?: string
  body?: string
  assignee?: string | null
  status?: string
  priority?: number
}

/** Patch a task on the dashboard board. */
export async function updateDashboardKanbanTask(
  taskId: string,
  updates: UpdateDashboardKanbanTaskInput,
  board?: string,
): Promise<DashboardKanbanTask> {
  const wrapped = await dashboardKanbanJson<{ task: DashboardKanbanTask }>(
    `/api/plugins/kanban/tasks/${encodeURIComponent(taskId)}`,
    {
      method: 'PATCH',
      body: JSON.stringify(updates),
    },
    board ? { board } : {},
  )
  return wrapped.task
}

/** Delete a task on the dashboard board when the plugin supports DELETE. */
export async function deleteDashboardKanbanTask(
  taskId: string,
  board?: string,
): Promise<void> {
  const path = `/api/plugins/kanban/tasks/${encodeURIComponent(taskId)}`
  const res = await dashboardFetch(withQuery(path, board ? { board } : {}), {
    method: 'DELETE',
    headers: { 'Content-Type': 'application/json' },
    signal: AbortSignal.timeout(PROXY_TIMEOUT_MS),
  })
  if (!res.ok) {
    const body = await res.text().catch(() => '')
    throw new Error(
      `Dashboard kanban proxy: DELETE ${path} → ${res.status}${body ? ` — ${body.slice(0, 200)}` : ''}`,
    )
  }
}

/**
 * List boards. The dashboard kanban plugin supports multi-board (project
 * scoping); each board is a separate SQLite file under
 * `<hermes-root>/kanban/boards/<slug>/kanban.db`. The first board is
 * always `default` and lives at `<hermes-root>/kanban.db` for back-compat.
 */
export type DashboardKanbanBoard = {
  slug: string
  display_name?: string | null
  archived?: boolean
}

export function listDashboardKanbanBoards(): Promise<{
  boards: Array<DashboardKanbanBoard>
  current: string
}> {
  return dashboardKanbanJson('/api/plugins/kanban/boards')
}
