/**
 * Full-page platform skill detail: view / edit / delete / bind agents.
 */
import { useEffect, useMemo, useState } from 'react'
import { Link, useNavigate } from '@tanstack/react-router'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { HugeiconsIcon } from '@hugeicons/react'
import {
  AddTeamIcon,
  ArrowLeft01Icon,
  Delete02Icon,
} from '@hugeicons/core-free-icons'
import { Button } from '@/components/ui/button'
import { Switch } from '@/components/ui/switch'
import { Markdown } from '@/components/prompt-kit/markdown'
import { toast } from '@/components/ui/toast'
import {
  AddToAgentDialog,
  type AddToAgentTarget,
} from './add-to-agent-dialog'

type AgentSummary = {
  agentId: string
  id?: string
  name?: string
  displayName?: string
  runtime?: string
}

type SkillDetail = {
  skill: {
    id: string
    name: string
    description: string
    category: string
    content: string
    origin?: { kind?: string; source?: string }
  }
  agents: Array<{ agentId: string; enabled: boolean }>
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

export function PlatformSkillDetailScreen({ skillId }: { skillId: string }) {
  const navigate = useNavigate()
  const queryClient = useQueryClient()
  const [editing, setEditing] = useState(false)
  const [name, setName] = useState('')
  const [description, setDescription] = useState('')
  const [category, setCategory] = useState('')
  const [content, setContent] = useState('')
  const [preview, setPreview] = useState(true)
  const [addOpen, setAddOpen] = useState(false)

  const detailQuery = useQuery({
    queryKey: ['platform-skill', skillId],
    queryFn: () =>
      fetchJson<SkillDetail>(
        `/api/platform-skills/${encodeURIComponent(skillId)}`,
      ),
  })

  const agentsQuery = useQuery({
    queryKey: ['agents-list-for-skills'],
    queryFn: async () => {
      const payload = await fetchJson<{ agents?: Array<AgentSummary> }>(
        '/api/agents',
      )
      return payload.agents ?? []
    },
  })

  useEffect(() => {
    const skill = detailQuery.data?.skill
    if (!skill) return
    setName(skill.name)
    setDescription(skill.description || '')
    setCategory(skill.category || '')
    setContent(skill.content || '')
    setEditing(false)
  }, [detailQuery.data?.skill])

  const saveMutation = useMutation({
    mutationFn: () =>
      fetchJson<{ skill: SkillDetail['skill'] }>(
        `/api/platform-skills/${encodeURIComponent(skillId)}`,
        {
          method: 'PATCH',
          body: JSON.stringify({
            name: name.trim(),
            description,
            category,
            content,
          }),
        },
      ),
    onSuccess: (payload) => {
      void queryClient.invalidateQueries({ queryKey: ['platform-skills'] })
      void queryClient.invalidateQueries({ queryKey: ['platform-skill'] })
      setEditing(false)
      toast(`已保存 ${payload.skill.name}`, { type: 'success' })
      if (payload.skill.id !== skillId) {
        void navigate({
          to: '/skills/$skillId',
          params: { skillId: payload.skill.id },
          replace: true,
        })
      }
    },
    onError: (error: Error) => {
      toast(error.message || '保存失败', { type: 'error' })
    },
  })

  const deleteMutation = useMutation({
    mutationFn: () =>
      fetchJson(`/api/platform-skills/${encodeURIComponent(skillId)}`, {
        method: 'DELETE',
      }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['platform-skills'] })
      toast('已删除 skill', { type: 'success' })
      void navigate({ to: '/skills' })
    },
    onError: (error: Error) => {
      toast(error.message || '删除失败', { type: 'error' })
    },
  })

  const bindMutation = useMutation({
    mutationFn: async (input: {
      agentId: string
      action: 'remove' | 'enable' | 'disable'
    }) => {
      if (input.action === 'remove') {
        return fetchJson(
          `/api/agents/${encodeURIComponent(input.agentId)}/skills/${encodeURIComponent(skillId)}`,
          { method: 'DELETE' },
        )
      }
      return fetchJson(
        `/api/agents/${encodeURIComponent(input.agentId)}/skills/${encodeURIComponent(skillId)}`,
        {
          method: 'PATCH',
          body: JSON.stringify({ enabled: input.action === 'enable' }),
        },
      )
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['platform-skill'] })
      void queryClient.invalidateQueries({ queryKey: ['platform-skills'] })
      void queryClient.invalidateQueries({ queryKey: ['agent-skills'] })
    },
    onError: (error: Error) => {
      toast(error.message || '更新失败', { type: 'error' })
    },
  })

  const addToAgentsMutation = useMutation({
    mutationFn: async (agentIds: Array<string>) => {
      for (const agentId of agentIds) {
        await fetchJson(`/api/agents/${encodeURIComponent(agentId)}/skills`, {
          method: 'POST',
          body: JSON.stringify({ skillIds: [skillId] }),
        })
      }
      return agentIds.length
    },
    onSuccess: (count) => {
      setAddOpen(false)
      void queryClient.invalidateQueries({ queryKey: ['platform-skill'] })
      void queryClient.invalidateQueries({ queryKey: ['platform-skills'] })
      void queryClient.invalidateQueries({ queryKey: ['agent-skills'] })
      toast(
        count === 1 ? '已添加到智能体' : `已添加到 ${count} 个智能体`,
        { type: 'success' },
      )
    },
    onError: (error: Error) => {
      toast(error.message || '添加失败', { type: 'error' })
    },
  })

  const agents = agentsQuery.data ?? []
  const bindings = detailQuery.data?.agents ?? []
  const boundIds = useMemo(
    () => new Set(bindings.map((b) => b.agentId)),
    [bindings],
  )

  const addDialogAgents: Array<AddToAgentTarget> = agents.map((agent) => {
    const id = agentIdOf(agent)
    return {
      agentId: id,
      name: agent.name || id,
      displayName: agent.displayName,
      runtime: agent.runtime,
      alreadyBound: boundIds.has(id),
    }
  })

  const skill = detailQuery.data?.skill
  const dirty =
    editing &&
    skill &&
    (name.trim() !== skill.name ||
      description !== (skill.description || '') ||
      category !== (skill.category || '') ||
      content !== (skill.content || ''))

  return (
    <div className="min-h-full overflow-y-auto bg-surface text-ink">
      <div className="mx-auto flex w-full max-w-[960px] flex-col gap-5 px-4 py-6 pb-[calc(var(--tabbar-h,80px)+1.5rem)] sm:px-6 lg:px-8">
        <div className="flex flex-wrap items-center gap-2">
          <Link
            to="/skills"
            className="inline-flex items-center gap-1 rounded-lg px-2 py-1.5 text-sm text-primary-500 hover:bg-primary-100 hover:text-ink"
          >
            <HugeiconsIcon icon={ArrowLeft01Icon} size={14} />
            Skills
          </Link>
        </div>

        {detailQuery.isLoading ? (
          <p className="text-sm text-primary-500">加载中…</p>
        ) : detailQuery.isError || !skill ? (
          <div className="rounded-2xl border border-primary-200 bg-primary-50/70 p-6">
            <p className="text-sm text-primary-500">
              {detailQuery.error instanceof Error
                ? detailQuery.error.message
                : '找不到该 skill'}
            </p>
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="mt-3"
              onClick={() => void navigate({ to: '/skills' })}
            >
              返回列表
            </Button>
          </div>
        ) : (
          <>
            <header className="rounded-2xl border border-primary-200 bg-primary-50/85 p-4 backdrop-blur-xl sm:p-5">
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div className="min-w-0 flex-1 space-y-2">
                  {editing ? (
                    <input
                      value={name}
                      onChange={(e) => setName(e.target.value)}
                      className="h-10 w-full max-w-lg rounded-lg border border-primary-200 bg-primary-50 px-3 text-xl font-medium text-ink outline-none focus:border-primary"
                    />
                  ) : (
                    <h1 className="text-2xl font-medium text-ink text-balance sm:text-3xl">
                      {skill.name}
                    </h1>
                  )}
                  <div className="flex flex-wrap items-center gap-2">
                    {editing ? (
                      <input
                        value={category}
                        onChange={(e) => setCategory(e.target.value)}
                        placeholder="Category"
                        className="h-8 rounded-md border border-primary-200 bg-primary-50 px-2 text-xs outline-none"
                      />
                    ) : (
                      <span className="rounded-md bg-primary-100 px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-primary-500">
                        {skill.category?.trim() || 'General'}
                      </span>
                    )}
                    {skill.origin?.kind ? (
                      <span className="text-[11px] text-primary-400">
                        origin: {skill.origin.kind}
                      </span>
                    ) : null}
                  </div>
                  {editing ? (
                    <textarea
                      value={description}
                      onChange={(e) => setDescription(e.target.value)}
                      rows={2}
                      placeholder="描述"
                      className="w-full rounded-lg border border-primary-200 bg-primary-50 px-3 py-2 text-sm outline-none focus:border-primary"
                    />
                  ) : (
                    <p className="text-sm text-primary-500 text-pretty">
                      {skill.description || '无描述'}
                    </p>
                  )}
                </div>
                <div className="flex flex-wrap gap-2">
                  {!editing ? (
                    <>
                      <Button
                        type="button"
                        size="sm"
                        variant="outline"
                        onClick={() => setEditing(true)}
                      >
                        编辑
                      </Button>
                      <Button
                        type="button"
                        size="sm"
                        onClick={() => setAddOpen(true)}
                      >
                        <HugeiconsIcon icon={AddTeamIcon} size={14} />
                        添加到智能体
                      </Button>
                    </>
                  ) : (
                    <>
                      <Button
                        type="button"
                        size="sm"
                        variant="ghost"
                        disabled={saveMutation.isPending}
                        onClick={() => {
                          setName(skill.name)
                          setDescription(skill.description || '')
                          setCategory(skill.category || '')
                          setContent(skill.content || '')
                          setEditing(false)
                        }}
                      >
                        取消
                      </Button>
                      <Button
                        type="button"
                        size="sm"
                        disabled={!name.trim() || !dirty || saveMutation.isPending}
                        onClick={() => saveMutation.mutate()}
                      >
                        {saveMutation.isPending ? '保存中…' : '保存'}
                      </Button>
                    </>
                  )}
                </div>
              </div>
            </header>

            <section className="rounded-2xl border border-primary-200 bg-primary-50/70 p-4 sm:p-5">
              <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
                <h2 className="text-xs font-medium uppercase tracking-wider text-primary-500">
                  SKILL.md
                </h2>
                <div className="flex gap-1 rounded-lg border border-primary-200 p-0.5">
                  <button
                    type="button"
                    className={`rounded-md px-2.5 py-1 text-xs ${
                      preview
                        ? 'bg-primary-100 font-medium text-ink'
                        : 'text-primary-500'
                    }`}
                    onClick={() => setPreview(true)}
                    disabled={editing}
                  >
                    预览
                  </button>
                  <button
                    type="button"
                    className={`rounded-md px-2.5 py-1 text-xs ${
                      !preview || editing
                        ? 'bg-primary-100 font-medium text-ink'
                        : 'text-primary-500'
                    }`}
                    onClick={() => setPreview(false)}
                  >
                    源码
                  </button>
                </div>
              </div>
              {editing || !preview ? (
                <textarea
                  value={content}
                  onChange={(e) => setContent(e.target.value)}
                  readOnly={!editing}
                  rows={22}
                  className="w-full rounded-xl border border-primary-200 bg-primary-100/30 px-3 py-3 font-mono text-xs leading-relaxed text-ink outline-none focus:border-primary"
                />
              ) : (
                <div className="min-h-[20rem] rounded-xl border border-primary-200 bg-primary-100/30 p-4 text-sm">
                  <Markdown>{content || '_空_'}</Markdown>
                </div>
              )}
            </section>

            <section className="rounded-2xl border border-primary-200 bg-primary-50/70 p-4 sm:p-5">
              <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
                <h2 className="text-xs font-medium uppercase tracking-wider text-primary-500">
                  已绑定智能体 ({bindings.length})
                </h2>
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  onClick={() => setAddOpen(true)}
                >
                  <HugeiconsIcon icon={AddTeamIcon} size={14} />
                  添加
                </Button>
              </div>
              {bindings.length === 0 ? (
                <p className="text-sm text-primary-500">
                  尚未绑定任何智能体。
                </p>
              ) : (
                <ul className="space-y-2">
                  {bindings.map((binding) => {
                    const agent = agents.find(
                      (a) => agentIdOf(a) === binding.agentId,
                    )
                    return (
                      <li
                        key={binding.agentId}
                        className="flex items-center justify-between gap-3 rounded-xl border border-primary-200 bg-primary-100/40 px-3 py-2.5"
                      >
                        <div className="min-w-0">
                          <p className="truncate text-sm font-medium text-ink">
                            {agent ? agentLabel(agent) : binding.agentId}
                          </p>
                          {agent?.runtime ? (
                            <p className="text-[11px] text-primary-500">
                              {agent.runtime}
                            </p>
                          ) : null}
                        </div>
                        <div className="flex items-center gap-2">
                          <Switch
                            checked={binding.enabled}
                            onCheckedChange={(enabled) => {
                              bindMutation.mutate({
                                agentId: binding.agentId,
                                action: enabled ? 'enable' : 'disable',
                              })
                            }}
                          />
                          <Button
                            type="button"
                            size="sm"
                            variant="ghost"
                            onClick={() =>
                              bindMutation.mutate({
                                agentId: binding.agentId,
                                action: 'remove',
                              })
                            }
                          >
                            移除
                          </Button>
                        </div>
                      </li>
                    )
                  })}
                </ul>
              )}
            </section>

            <section className="rounded-2xl border border-danger/30 bg-danger/5 p-4">
              <h2 className="text-xs font-medium uppercase tracking-wider text-danger">
                危险操作
              </h2>
              <p className="mt-1 text-sm text-primary-500">
                删除会移除平台目录条目及所有智能体绑定，不可恢复。
              </p>
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="mt-3 text-danger"
                disabled={deleteMutation.isPending}
                onClick={() => {
                  if (
                    window.confirm(
                      `删除平台 skill「${skill.name}」？绑定也会移除。`,
                    )
                  ) {
                    deleteMutation.mutate()
                  }
                }}
              >
                <HugeiconsIcon icon={Delete02Icon} size={14} />
                {deleteMutation.isPending ? '删除中…' : '删除 skill'}
              </Button>
            </section>
          </>
        )}
      </div>

      <AddToAgentDialog
        open={addOpen}
        onOpenChange={setAddOpen}
        skillName={skill?.name || ''}
        agents={addDialogAgents}
        saving={addToAgentsMutation.isPending}
        onConfirm={(ids) => addToAgentsMutation.mutate(ids)}
      />
    </div>
  )
}
