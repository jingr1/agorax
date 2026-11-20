import type { Page } from '@playwright/test'

export const PAGE_AGENTS = [
  {
    agentId: 'default',
    name: 'E2E Hermes',
    runtime: 'hermes',
    runtimeConfig: { profile: 'default' },
    status: 'idle',
  },
  {
    agentId: 'cc-impl',
    name: 'E2E Managed',
    runtime: 'claude-code',
    runtimeConfig: { command: 'claude', args: ['-p'] },
    status: 'idle',
  },
]

export async function installPageMocks(
  page: Page,
  options: { unboundSkills?: boolean } = {},
) {
  const jobs = [
    {
      id: 'daily-report',
      name: 'E2E daily report',
      prompt: 'Summarize tests',
      schedule: { kind: 'cron', expr: '0 9 * * *' },
      schedule_display: 'Every day at 09:00',
      enabled: true,
      state: 'scheduled',
      profile: 'default',
    },
    {
      id: 'weekly-review',
      name: 'E2E weekly review',
      prompt: 'Review tests',
      schedule: { kind: 'cron', expr: '0 9 * * 1' },
      schedule_display: 'Every Monday',
      enabled: true,
      state: 'scheduled',
      profile: 'default',
    },
  ]
  const skills = [
    {
      id: 'e2e-browser',
      slug: 'e2e-browser',
      name: 'E2E Browser Skill',
      description: 'Browser test fixture',
      category: 'Testing',
      tags: ['browser'],
      source: 'local',
      boundAgentCount: 0,
      createdAt: 1,
      updatedAt: 1,
    },
    {
      id: 'e2e-writer',
      slug: 'e2e-writer',
      name: 'E2E Writer Skill',
      description: 'Writing test fixture',
      category: 'Writing',
      tags: ['writing'],
      source: 'local',
      boundAgentCount: 0,
      createdAt: 1,
      updatedAt: 1,
    },
  ]
  const skillBindings = new Map(
    PAGE_AGENTS.map((agent) => [
      agent.agentId,
      options.unboundSkills
        ? []
        : [
            {
              agentId: agent.agentId,
              skillId: 'e2e-browser',
              enabled: false,
              createdAt: 1,
            },
          ],
    ]),
  )
  const servers = [
    {
      id: 'e2e-browser',
      name: 'E2E Browser MCP',
      transport: 'stdio',
      boundAgentCount: 0,
      createdAt: 1,
      updatedAt: 1,
    },
    {
      id: 'e2e-files',
      name: 'E2E Files MCP',
      transport: 'http',
      boundAgentCount: 0,
      createdAt: 1,
      updatedAt: 1,
    },
  ]
  type McpBinding = {
    agentId: string
    serverId: string
    name: string
    transport: string
    enabled: boolean
    createdAt: number
  }
  const mcpBindings = new Map<string, Array<McpBinding>>(
    PAGE_AGENTS.map((agent) => [agent.agentId, []]),
  )
  const fixtures: Record<string, unknown> = {
    '/api/gateway-status': {
      ok: true,
      connected: true,
      enhanced: true,
      capabilities: {
        sessions: true,
        skills: true,
        memory: true,
        config: true,
        jobs: true,
        mcp: true,
        mcpFallback: true,
      },
    },
    '/api/mcp': { servers: [] },
    '/api/agents': { agents: PAGE_AGENTS },
    '/api/agents/snapshot': {
      agents: [],
      providers: [],
      checkedAt: Date.now(),
    },
    '/api/profiles/list': { profiles: [{ name: 'default', active: true }] },
    '/api/platform-skills': { skills },
    '/api/platform-skills/e2e-browser': {
      skill: {
        ...skills[0],
        content: '# E2E Browser Skill\n\nBrowser test fixture',
        revisionId: 'e2e-revision',
        files: [],
      },
      agents: [],
      deployments: [],
      revisions: [],
    },
    '/api/platform-mcp': { servers },
    '/api/hermes-jobs': { jobs },
    '/api/hermes-jobs/profiles': {
      profiles: [{ name: 'default', active: true }],
    },
    '/api/available-agents': { ok: true, agents: [] },
    '/api/rooms': { ok: true, rooms: [] },
    '/api/missions': { missions: [] },
    '/api/projects': { projects: [] },
    '/api/swarm-runtime': {
      entries: [],
      tmuxAvailable: false,
      checkedAt: Date.now(),
    },
    '/api/swarm-health': {
      workspaceModel: null,
      summary: {
        totalWorkers: 0,
        totalAuthErrors24h: 0,
        distinctProviders: [],
      },
    },
    '/api/swarm-roster': { roster: { workers: [] } },
    '/api/swarm-missions': { missions: [] },
    '/api/crew-status': { workers: [], sessions: [] },
    '/api/integrations': { integrations: [] },
    '/api/orchestrator-active-gates': { gates: [] },
    '/api/knowledge/list': { files: [], folders: [], available: true },
    '/api/knowledge/graph': { nodes: [], edges: [] },
    '/api/knowledge/config': { enabled: false, path: '' },
    '/api/external-memory/providers': { providers: [] },
    '/api/hermes-config': { config: {}, env: {} },
    '/api/config-get': { config: {} },
    '/api/models': { models: [], providers: [], current: null },
    '/api/hermesworld/reservations': { reservations: [] },
    '/api/terminal-input': { ok: true },
    '/api/terminal-resize': { ok: true },
    '/api/terminal-close': { ok: true },
  }
  await page.route('**/api/**', async (route) => {
    const url = new URL(route.request().url())
    const pathname = url.pathname
    if (pathname === '/api/mcp') {
      const bindings =
        mcpBindings.get(url.searchParams.get('profile') || 'default') ?? []
      await route.fulfill({
        json: {
          servers: bindings.map((binding) => ({
            id: binding.serverId,
            name: binding.name,
            transport: binding.transport,
            enabled: binding.enabled,
            status: 'connected',
            tools: [],
            toolCount: 0,
            category: 'Testing',
            command: 'e2e-mcp',
            args: [],
            config: { command: 'e2e-mcp' },
          })),
          total: bindings.length,
          categories: ['All'],
        },
      })
    } else if (pathname === '/api/platform-skills/e2e-browser') {
      await route.fulfill({
        json: {
          ...(fixtures[pathname] as Record<string, unknown>),
          agents: [...skillBindings.entries()].flatMap(([agentId, bindings]) =>
            bindings
              .filter((binding) => binding.skillId === 'e2e-browser')
              .map((binding) => ({ agentId, enabled: binding.enabled })),
          ),
        },
      })
    } else if (pathname === '/api/files') {
      await route.fulfill({
        json:
          url.searchParams.get('action') === 'read'
            ? {
                path: '/workspace/README.md',
                name: 'README.md',
                content: '# E2E workspace\n\nIsolated file preview.',
                type: 'text',
                encoding: 'utf-8',
              }
            : {
                entries: [
                  {
                    name: 'README.md',
                    path: '/workspace/README.md',
                    type: 'file',
                  },
                ],
              },
      })
    } else if (pathname === '/api/workspace') {
      await route.fulfill({
        json: {
          path: '/workspace',
          folderName: 'E2E Workspace',
          source: 'test',
          isValid: true,
          workspaces: [],
          last: '',
        },
      })
    } else if (pathname === '/api/memory/list') {
      await route.fulfill({
        json: {
          agentId: 'default',
          writable: true,
          agents: PAGE_AGENTS.map((agent) => ({
            id: agent.agentId,
            name: agent.name,
            runtime: agent.runtime,
            memoryKind: 'hermes',
            writable: true,
          })),
          files: [
            {
              path: 'MEMORY.md',
              name: 'MEMORY.md',
              size: 64,
              modified: '2026-01-01T00:00:00Z',
            },
          ],
        },
      })
    } else if (pathname === '/api/memory/read') {
      await route.fulfill({
        json: {
          path: 'MEMORY.md',
          content: 'E2E durable memory\nAlways keep test fixtures isolated.',
        },
      })
    } else if (/^\/api\/agents\/[^/]+\/capabilities$/.test(pathname)) {
      await route.fulfill({
        json: {
          agentId: pathname.split('/')[3],
          skills: [],
          mcpServers: [],
          tools: [],
          model: '',
        },
      })
    } else if (/^\/api\/agents\/[^/]+\/skills$/.test(pathname)) {
      const bindings = skillBindings.get(pathname.split('/')[3])
      if (
        route.request().method() === 'POST' &&
        bindings &&
        !bindings.some((entry) => entry.skillId === 'e2e-browser')
      )
        bindings.push({
          agentId: pathname.split('/')[3],
          skillId: 'e2e-browser',
          enabled: true,
          createdAt: Date.now(),
        })
      await route.fulfill({
        json: { skills: skillBindings.get(pathname.split('/')[3]) ?? [] },
      })
    } else if (/^\/api\/agents\/[^/]+\/skills\/e2e-browser$/.test(pathname)) {
      const bindings = skillBindings.get(pathname.split('/')[3])
      if (!bindings) throw new Error('Unknown fixture agent')
      if (route.request().method() === 'DELETE')
        bindings.splice(0, bindings.length)
      else bindings[0].enabled = Boolean(route.request().postDataJSON().enabled)
      await route.fulfill({ json: { ok: true, binding: bindings[0] } })
    } else if (/^\/api\/agents\/[^/]+\/mcp$/.test(pathname)) {
      const agentId = pathname.split('/')[3]
      const bindings = mcpBindings.get(agentId)
      if (!bindings) throw new Error('Unknown fixture agent')
      if (route.request().method() === 'POST') {
        const { serverIds } = route.request().postDataJSON() as {
          serverIds: Array<string>
        }
        for (const serverId of serverIds) {
          const server = servers.find((entry) => entry.id === serverId)
          if (!server) throw new Error('Unknown fixture MCP server')
          if (!bindings.some((entry) => entry.serverId === serverId))
            bindings.push({
              agentId,
              serverId,
              name: server.name,
              transport: server.transport,
              enabled: true,
              createdAt: Date.now(),
            })
        }
      }
      await route.fulfill({ json: { servers: bindings } })
    } else if (/^\/api\/agents\/[^/]+\/mcp\/[^/]+$/.test(pathname)) {
      const agentId = pathname.split('/')[3]
      const serverId = pathname.split('/')[5]
      const bindings = mcpBindings.get(agentId)
      if (!bindings) throw new Error('Unknown fixture agent')
      if (route.request().method() === 'DELETE')
        mcpBindings.set(
          agentId,
          bindings.filter((entry) => entry.serverId !== serverId),
        )
      await route.fulfill({ json: { ok: true } })
    } else if (
      /^\/api\/hermes-jobs\/[^/]+$/.test(pathname) &&
      ['pause', 'resume'].includes(url.searchParams.get('action') ?? '')
    ) {
      const job = jobs.find((entry) => entry.id === pathname.split('/')[3])
      if (!job) throw new Error('Unknown fixture job')
      job.enabled = url.searchParams.get('action') === 'resume'
      job.state = job.enabled ? 'scheduled' : 'paused'
      await route.fulfill({ json: { ok: true, job } })
    } else if (Object.hasOwn(fixtures, pathname)) {
      await route.fulfill({ json: fixtures[pathname] })
    } else {
      await route.fallback()
    }
  })
  await page.addInitScript({
    content: `(() => {
    const originalFetch = window.fetch.bind(window)
    window.fetch = async (input, init) => {
      const request = new Request(input instanceof Request ? input : new URL(String(input), location.href), init)
      if (new URL(request.url).pathname !== '/api/terminal-stream') return originalFetch(input, init)
      const encoder = new TextEncoder()
      return new Response(new ReadableStream({ start(controller) {
        controller.enqueue(encoder.encode('event: session\\ndata: ' + JSON.stringify({ sessionId: 'e2e-terminal-' + crypto.randomUUID() }) + '\\n\\n'))
        controller.enqueue(encoder.encode('event: data\\ndata: ' + JSON.stringify({ data: 'E2E isolated terminal\\r\\n$ ' }) + '\\n\\n'))
      } }), { headers: { 'content-type': 'text/event-stream' } })
    }
  })()`,
  })
}
