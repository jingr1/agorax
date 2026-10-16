/**
 * Platform skills catalog list — filters + rows only.
 * Detail / edit / delete live on `/skills/$skillId`.
 */
import { useMemo, useState } from 'react'
import { Link, useNavigate } from '@tanstack/react-router'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { HugeiconsIcon } from '@hugeicons/react'
import { PlusSignIcon, PuzzleIcon } from '@hugeicons/core-free-icons'
import { PageHeader } from '@/components/layout/page-header'
import { PageShell } from '@/components/layout/page-shell'
import { Section } from '@/components/layout/section'
import {
  Toolbar,
  ToolbarSearch,
  ToolbarSelect,
} from '@/components/layout/toolbar'
import { Button } from '@/components/ui/button'
import { Switch } from '@/components/ui/switch'
import { toast } from '@/components/ui/toast'
import { cn } from '@/lib/utils'
import { CreateSkillDialog } from './create-skill-dialog'

type PlatformSkillSummary = {
  id: string
  name: string
  description: string
  category: string
  boundAgentCount: number
  origin?: { kind?: string; source?: string }
}

type AgentSummary = {
  agentId: string
  id?: string
  name?: string
  displayName?: string
  runtime?: string
  runtimeConfig?: { profile?: string }
  profile?: string
}

type AgentSkillBinding = {
  agentId: string
  skillId: string
  enabled: boolean
  name: string
  description: string
}

function agentIdOf(agent: AgentSummary): string {
  return agent.agentId || agent.id || ''
}

function agentLabel(agent: AgentSummary): string {
  return agent.displayName || agent.name || agentIdOf(agent)
}

async function fetchJson<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, {
    ...init,
    headers: {
      'Content-Type': 'application/json',
      ...(init?.headers ?? {}),
    },
  })
  const payload = (await response.json().catch(() => ({}))) as T & {
    error?: string
  }
  if (!response.ok) {
    throw new Error(payload.error || `Request failed (${response.status})`)
  }
  return payload
}

export function PlatformSkillsScreen() {
  const navigate = useNavigate()
  const queryClient = useQueryClient()
  const [search, setSearch] = useState('')
  const [category, setCategory] = useState('All')
  const [sort, setSort] = useState<'name' | 'category'>('name')
  const [filterAgentId, setFilterAgentId] = useState<string>('all')
  const [createOpen, setCreateOpen] = useState(false)

  const skillsQuery = useQuery({
    queryKey: ['platform-skills'],
    queryFn: () =>
      fetchJson<{ skills: Array<PlatformSkillSummary> }>(
        '/api/platform-skills',
      ),
  })

  const agentsQuery = useQuery({
    queryKey: ['agents-list-for-skills'],
    queryFn: async () => {
      const payload = await fetchJson<{
        agents?: Array<AgentSummary>
      }>('/api/agents')
      return payload.agents ?? []
    },
  })

  const agentBindingsQuery = useQuery({
    queryKey: ['agent-skills', filterAgentId],
    enabled: filterAgentId !== 'all',
    queryFn: () =>
      fetchJson<{ skills: Array<AgentSkillBinding> }>(
        `/api/agents/${encodeURIComponent(filterAgentId)}/skills`,
      ),
  })

  const syncMutation = useMutation({
    mutationFn: () =>
      fetchJson<{
        ok: boolean
        skillsScanned?: number
        skillsUpserted?: number
        bindingsAdded?: number
      }>('/api/platform-skills/seed', { method: 'POST' }),
    onSuccess: (payload) => {
      void queryClient.invalidateQueries({ queryKey: ['platform-skills'] })
      void queryClient.invalidateQueries({ queryKey: ['agent-skills'] })
      toast(
        `已同步（扫描 ${payload.skillsScanned ?? 0}，新增 ${payload.skillsUpserted ?? 0}，绑定 ${payload.bindingsAdded ?? 0}）`,
        { type: 'success' },
      )
    },
    onError: (error: Error) => {
      toast(error.message || '同步失败', { type: 'error' })
    },
  })

  const bindMutation = useMutation({
    mutationFn: async (input: {
      agentId: string
      skillId: string
      action: 'enable' | 'disable'
    }) =>
      fetchJson(
        `/api/agents/${encodeURIComponent(input.agentId)}/skills/${encodeURIComponent(input.skillId)}`,
        {
          method: 'PATCH',
          body: JSON.stringify({ enabled: input.action === 'enable' }),
        },
      ),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['platform-skills'] })
      void queryClient.invalidateQueries({ queryKey: ['agent-skills'] })
    },
    onError: (error: Error) => {
      toast(error.message || '更新失败', { type: 'error' })
    },
  })

  const skills = skillsQuery.data?.skills ?? []
  const agents = agentsQuery.data ?? []
  const bindingBySkillId = useMemo(() => {
    const map = new Map<string, AgentSkillBinding>()
    for (const b of agentBindingsQuery.data?.skills ?? []) {
      map.set(b.skillId, b)
    }
    return map
  }, [agentBindingsQuery.data?.skills])

  const categories = useMemo(() => {
    const set = new Set<string>(['All'])
    for (const skill of skills) {
      set.add(skill.category?.trim() || 'General')
    }
    return [...set].sort((a, b) => {
      if (a === 'All') return -1
      if (b === 'All') return 1
      return a.localeCompare(b)
    })
  }, [skills])

  const filteredSkills = useMemo(() => {
    const q = search.trim().toLowerCase()
    let list = skills
    if (filterAgentId !== 'all') {
      const boundIds = new Set(bindingBySkillId.keys())
      list = list.filter((s) => boundIds.has(s.id))
    }
    if (category !== 'All') {
      list = list.filter((s) => (s.category?.trim() || 'General') === category)
    }
    if (q) {
      list = list.filter(
        (s) =>
          s.name.toLowerCase().includes(q) ||
          s.description.toLowerCase().includes(q) ||
          (s.category || '').toLowerCase().includes(q),
      )
    }
    return [...list].sort((a, b) => {
      if (sort === 'category') {
        const cmp = (a.category || '').localeCompare(b.category || '')
        if (cmp !== 0) return cmp
      }
      return a.name.localeCompare(b.name)
    })
  }, [skills, search, filterAgentId, category, sort, bindingBySkillId])

  return (
    <PageShell>
      <PageHeader
        icon={PuzzleIcon}
        title="Skills"
        meta={
          filteredSkills.length !== skills.length
            ? `${filteredSkills.length} / ${skills.length}`
            : skills.length
        }
        description={
          <>
            点「同步本地 skills」从磁盘导入；点击行进入详情。Composer{' '}
            <code className="text-xs">/</code> 仅列出已启用绑定。
          </>
        }
        actions={
          <>
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={syncMutation.isPending}
              onClick={() => syncMutation.mutate()}
            >
              同步本地 skills
            </Button>
            <Button type="button" size="sm" onClick={() => setCreateOpen(true)}>
              <HugeiconsIcon icon={PlusSignIcon} size={14} />
              新建 skill
            </Button>
          </>
        }
      />

      <Section className="p-3">
        <Toolbar>
          <ToolbarSelect
            label="Agent"
            value={filterAgentId}
            onChange={(event) => setFilterAgentId(event.target.value)}
            aria-label="按智能体筛选"
          >
            <option value="all">全部（目录）</option>
            {agents.map((agent) => (
              <option key={agentIdOf(agent)} value={agentIdOf(agent)}>
                {agentLabel(agent)}
                {agent.runtime ? ` · ${agent.runtime}` : ''}
              </option>
            ))}
          </ToolbarSelect>
          <ToolbarSelect
            label="Category"
            value={category}
            onChange={(e) => setCategory(e.target.value)}
          >
            {categories.map((c) => (
              <option key={c} value={c}>
                {c}
              </option>
            ))}
          </ToolbarSelect>
          <ToolbarSelect
            label="Sort"
            value={sort}
            onChange={(e) =>
              setSort(e.target.value === 'category' ? 'category' : 'name')
            }
          >
            <option value="name">Name</option>
            <option value="category">Category</option>
          </ToolbarSelect>
          <ToolbarSearch
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            placeholder="搜索 skills…"
          />
        </Toolbar>
      </Section>

      <Section className="overflow-hidden p-0">
        {skillsQuery.isLoading ? (
          <p className="p-4 text-sm text-fg-muted">加载中…</p>
        ) : filteredSkills.length === 0 ? (
          <p className="p-4 text-sm text-fg-muted">
            没有 skill。点「同步本地 skills」从磁盘导入，或新建一个。
          </p>
        ) : (
          <ul className="divide-y divide-border">
            {filteredSkills.map((skill) => {
              const binding = bindingBySkillId.get(skill.id)
              return (
                <li key={skill.id}>
                  <div className="flex items-start gap-3 px-4 py-3 hover:bg-card">
                    <Link
                      to="/skills/$skillId"
                      params={{ skillId: skill.id }}
                      className="min-w-0 flex-1 text-left"
                    >
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="font-medium text-ink">
                          {skill.name}
                        </span>
                        <span className="rounded-md bg-primary-100 px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-primary-500">
                          {skill.category?.trim() || 'General'}
                        </span>
                      </div>
                      <p className="mt-1 line-clamp-2 text-sm text-primary-500">
                        {skill.description || '无描述'}
                      </p>
                      <p className="mt-1 text-[11px] text-primary-400 tabular-nums">
                        {skill.boundAgentCount} 个智能体
                      </p>
                    </Link>
                    {filterAgentId !== 'all' && binding ? (
                      <div className="flex shrink-0 flex-col items-end gap-1 pt-0.5">
                        <Switch
                          checked={binding.enabled}
                          onCheckedChange={(enabled) => {
                            bindMutation.mutate({
                              agentId: filterAgentId,
                              skillId: skill.id,
                              action: enabled ? 'enable' : 'disable',
                            })
                          }}
                          aria-label={`启用 ${skill.name}`}
                        />
                        <span className={cn('text-[10px] text-primary-500')}>
                          {binding.enabled ? 'Enabled' : 'Disabled'}
                        </span>
                      </div>
                    ) : null}
                  </div>
                </li>
              )
            })}
          </ul>
        )}
      </Section>

      <CreateSkillDialog
        open={createOpen}
        onOpenChange={setCreateOpen}
        agents={agents}
        onCreated={(skill) => {
          void queryClient.invalidateQueries({ queryKey: ['platform-skills'] })
          void navigate({
            to: '/skills/$skillId',
            params: { skillId: skill.id },
          })
        }}
      />
    </PageShell>
  )
}
