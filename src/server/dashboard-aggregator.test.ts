import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { buildDashboardOverview } from './dashboard-aggregator'
import type { DashboardFetcher } from './dashboard-aggregator'

function jsonResponse(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

function makeFetcher(routes: Record<string, unknown>): DashboardFetcher {
  return async (path: string) => {
    const key = Object.keys(routes).find((p) => path.startsWith(p))
    if (key === undefined) {
      return new Response('not found', { status: 404 })
    }
    const value = routes[key]
    if (value instanceof Response) return value
    return jsonResponse(value)
  }
}

describe('buildDashboardOverview', () => {
  const originalHermesHome = process.env.HERMES_HOME
  let tempHome = ''

  beforeEach(() => {
    // Force the dashboard fan-out path so stub fetchers are exercised.
    process.env.HERMES_USE_DASHBOARD = '1'
    // Isolate from the real ~/.hermes skills/.usage.json so local FS
    // data cannot override the stub analytics payload under test.
    // Seed a minimal profile config so modelInfo local fallback still works.
    tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'dashboard-agg-'))
    process.env.HERMES_HOME = tempHome
    fs.writeFileSync(
      path.join(tempHome, 'config.yaml'),
      ['model:', '  provider: openai-codex', '  default: gpt-5.4', ''].join(
        '\n',
      ),
      'utf-8',
    )
  })
  afterEach(() => {
    delete process.env.HERMES_USE_DASHBOARD
    if (originalHermesHome === undefined) delete process.env.HERMES_HOME
    else process.env.HERMES_HOME = originalHermesHome
    fs.rmSync(tempHome, { recursive: true, force: true })
  })

  it('returns null sections when every upstream call fails', async () => {
    const fetcher: DashboardFetcher = async () =>
      new Response('boom', { status: 500 })
    const overview = await buildDashboardOverview({ fetcher })
    expect(overview.status).toBeNull()
    expect(overview.platforms).toEqual([])
    expect(overview.cron).toBeNull()
    expect(overview.kanban).toBeNull()
    // Model falls back to local profile config when Dashboard /api/model/info fails.
    expect(overview.modelInfo).toMatchObject({
      provider: expect.any(String),
      model: expect.any(String),
    })
    expect(overview.analytics).toBeNull()
  })

  it('parses /api/status into status + platforms', async () => {
    const fetcher = makeFetcher({
      '/api/status': {
        gateway_state: 'running',
        active_agents: 2,
        restart_requested: false,
        updated_at: '2026-05-02T19:00:00Z',
        version: '0.12.0',
        release_date: '2026.4.30',
        config_version: 17,
        latest_config_version: 23,
        hermes_home: '/Users/aurora/.hermes',
        platforms: {
          api_server: {
            state: 'connected',
            updated_at: '2026-05-02T19:00:00Z',
            error_message: null,
          },
          telegram: {
            state: 'error',
            updated_at: '2026-05-02T18:00:00Z',
            error_message: 'token revoked',
          },
        },
      },
    })
    const overview = await buildDashboardOverview({ fetcher })
    expect(overview.status).toMatchObject({
      gatewayState: 'running',
      activeAgents: 2,
      restartRequested: false,
      version: '0.12.0',
      hermesHome: '/Users/aurora/.hermes',
    })
    expect(overview.platforms).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: 'api_server', state: 'connected' }),
        expect.objectContaining({
          name: 'telegram',
          state: 'error',
          errorMessage: 'token revoked',
        }),
      ]),
    )
  })

  it('parses cron jobs and surfaces failures', async () => {
    const fetcher = makeFetcher({
      '/api/cron/jobs': {
        jobs: [
          {
            id: 'job-1',
            name: 'nightly',
            status: 'scheduled',
            next_run_at: '2099-01-01T00:00:00Z',
          },
          {
            id: 'job-2',
            name: 'broken',
            status: 'paused',
            last_status: 'failed',
            last_error: 'timeout',
            last_run_at: '2026-05-01T00:00:00Z',
          },
          {
            id: 'job-3',
            name: 'running-now',
            status: 'running',
          },
        ],
      },
    })
    const overview = await buildDashboardOverview({ fetcher })
    expect(overview.cron).toMatchObject({
      total: 3,
      paused: 1,
      running: 1,
      failed: 1,
    })
    expect(overview.cron?.recentFailures[0]).toMatchObject({
      id: 'job-2',
      lastError: 'timeout',
    })
  })

  it('parses analytics and skills usage', async () => {
    const fetcher = makeFetcher({
      '/api/analytics/usage': {
        period_days: 7,
        totals: {
          total_input: 1000,
          total_output: 200,
          total_cache_read: 50,
          total_reasoning: 10,
          total_sessions: 3,
          total_api_calls: 12,
          total_estimated_cost: 1.5,
        },
        by_model: [
          {
            model: 'gpt-5.4',
            input_tokens: 1_000_000,
            output_tokens: 50_000,
            api_calls: 10,
            estimated_cost: 1.2,
            sessions: 2,
          },
        ],
        daily: [
          { date: '2026-05-01', tokens: 100, sessions: 1, api_calls: 2 },
          { date: '2026-05-02', tokens: 200, sessions: 2, api_calls: 4 },
        ],
        skills: {
          summary: {
            total_skill_loads: 10,
            total_skill_edits: 2,
            total_skill_actions: 12,
            distinct_skills_used: 3,
          },
          top_skills: [
            {
              skill: 'systematic-debugging',
              total_count: 5,
              percentage: 50,
              last_used_at: 1777741371,
            },
          ],
        },
      },
    })
    const overview = await buildDashboardOverview({
      fetcher,
      analyticsWindowDays: 7,
    })
    expect(overview.analytics?.totalSessions).toBe(3)
    expect(overview.analytics?.topModels[0]?.id).toBe('gpt-5.4')
    expect(overview.skillsUsage?.topSkills[0].skill).toBe(
      'systematic-debugging',
    )
    const skillInsight = overview.insights.find((i) =>
      i.text.includes('systematic-debugging'),
    )
    expect(skillInsight).toBeTruthy()
  })

  it('parses model info', async () => {
    const fetcher = makeFetcher({
      '/api/model/info': {
        model: 'gpt-5.4',
        provider: 'openai-codex',
        effective_context_length: 272000,
        capabilities: { supports_tools: true, model_family: 'gpt' },
      },
    })
    const overview = await buildDashboardOverview({ fetcher })
    expect(overview.modelInfo).toEqual({
      provider: 'openai-codex',
      model: 'gpt-5.4',
      effectiveContextLength: 272000,
      capabilities: { supports_tools: true, model_family: 'gpt' },
    })
  })

  it('parses kanban board columns', async () => {
    const fetcher = makeFetcher({
      '/api/plugins/kanban/board': {
        columns: [
          {
            name: 'todo',
            tasks: [{ id: 't1', title: 'One', status: 'todo' }],
          },
          {
            name: 'blocked',
            tasks: [
              {
                id: 't2',
                title: 'Stuck',
                status: 'blocked',
                assignee: 'dev',
              },
            ],
          },
          {
            name: 'done',
            tasks: [{ id: 't3', title: 'Done', status: 'done' }],
          },
        ],
      },
    })
    const overview = await buildDashboardOverview({ fetcher })
    expect(overview.kanban).toMatchObject({
      total: 3,
      todo: 1,
      blocked: 1,
      done: 1,
    })
    expect(overview.kanban?.topBlocked[0]).toMatchObject({
      id: 't2',
      title: 'Stuck',
      assignee: 'dev',
    })
  })

  it('keeps partial success when some sections fail', async () => {
    const fetcher: DashboardFetcher = async (path: string) => {
      if (path.startsWith('/api/status')) {
        return jsonResponse({
          gateway_state: 'running',
          active_agents: 1,
          active_sessions: 3,
          platforms: {},
        })
      }
      if (path.startsWith('/api/cron/jobs')) {
        return jsonResponse({ jobs: [{ id: 'a', status: 'scheduled' }] })
      }
      return new Response('nope', { status: 401 })
    }
    const overview = await buildDashboardOverview({ fetcher })
    expect(overview.status?.gatewayState).toBe('running')
    expect(overview.status?.activeAgents).toBe(1)
    expect(overview.status?.activeSessions).toBe(3)
    expect(overview.cron?.total).toBe(1)
    expect(overview.kanban).toBeNull()
    // Model falls back to local profile config when Dashboard /api/model/info fails.
    expect(overview.modelInfo).toMatchObject({
      provider: expect.any(String),
      model: expect.any(String),
    })
    expect(overview.analytics).toBeNull()
  })
})
