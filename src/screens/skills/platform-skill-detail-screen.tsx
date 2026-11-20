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
  RefreshIcon,
} from '@hugeicons/core-free-icons'
import { SkillFilesPanel } from './skill-files-panel'
import { AddToAgentDialog } from './add-to-agent-dialog'
import type { PlatformSkillFile } from '@/server/platform-skills/types'
import type { AddToAgentTarget } from './add-to-agent-dialog'
import { Button } from '@/components/ui/button'
import { Switch } from '@/components/ui/switch'
import { Tabs, TabsList, TabsTab } from '@/components/ui/tabs'
import { toast } from '@/components/ui/toast'

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
    revisionId?: string
    deploymentMode?: 'symlink' | 'copy'
    allowCopyFallback?: boolean
    files?: Array<PlatformSkillFile>
    origin?: { kind?: string; source?: string }
  }
  agents: Array<{ agentId: string; enabled: boolean }>
  deployments?: Array<{
    agentId: string
    status: string
    delivery?: string
    actualMode?: 'symlink' | 'copy'
    message?: string
    hash?: string
    path?: string
  }>
  revisions?: Array<{ id: string; createdAt: number; hash: string }>
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
  const [editRevision, setEditRevision] = useState('')
  const [name, setName] = useState('')
  const [description, setDescription] = useState('')
  const [category, setCategory] = useState('')
  const [content, setContent] = useState('')
  const [files, setFiles] = useState<Array<PlatformSkillFile>>([])
  const [deploymentMode, setDeploymentMode] = useState<'symlink' | 'copy'>(
    'symlink',
  )
  const [allowCopyFallback, setAllowCopyFallback] = useState(true)
  const [addOpen, setAddOpen] = useState(false)

  const detailQuery = useQuery({
    queryKey: ['platform-skill', skillId],
    queryFn: () =>
      fetchJson<SkillDetail>(
        `/api/platform-skills/${encodeURIComponent(skillId)}`,
      ),
    refetchInterval: editing ? false : 5_000,
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
    if (!skill || editing) return
    setName(skill.name)
    setDescription(skill.description || '')
    setCategory(skill.category || '')
    setContent(skill.content || '')
    setFiles(skill.files ?? [])
    setDeploymentMode(skill.deploymentMode ?? 'symlink')
    setAllowCopyFallback(skill.allowCopyFallback !== false)
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
            files,
            expectedRevision: editRevision,
            deploymentMode,
            allowCopyFallback,
          }),
        },
      ),
    onSuccess: (payload) => {
      void queryClient.invalidateQueries({ queryKey: ['platform-skills'] })
      void queryClient.invalidateQueries({ queryKey: ['platform-skill'] })
      void queryClient.invalidateQueries({
        queryKey: ['chat', 'composer', 'agent-skills'],
      })
      void queryClient.invalidateQueries({ queryKey: ['agent-skills'] })
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

  const operationMutation = useMutation({
    mutationFn: (operation: Record<string, unknown>) =>
      fetchJson(`/api/platform-skills/${encodeURIComponent(skillId)}`, {
        method: 'POST',
        body: JSON.stringify({
          expectedRevision: detailQuery.data?.skill.revisionId ?? '',
          ...operation,
        }),
      }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['platform-skill'] })
      void queryClient.invalidateQueries({ queryKey: ['platform-skills'] })
      void queryClient.invalidateQueries({ queryKey: ['agent-skills'] })
      void queryClient.invalidateQueries({
        queryKey: ['chat', 'composer', 'agent-skills'],
      })
    },
    onError: (error: Error) => toast(error.message, { type: 'error' }),
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
      void queryClient.invalidateQueries({
        queryKey: ['chat', 'composer', 'agent-skills'],
      })
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
      void queryClient.invalidateQueries({
        queryKey: ['chat', 'composer', 'agent-skills'],
      })
      toast(count === 1 ? '已添加到智能体' : `已添加到 ${count} 个智能体`, {
        type: 'success',
      })
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
    (editing &&
      skill &&
      (name.trim() !== skill.name ||
        description !== (skill.description || '') ||
        category !== (skill.category || '') ||
        content !== (skill.content || ''))) ||
    (editing && JSON.stringify(files) !== JSON.stringify(skill?.files ?? [])) ||
    (editing &&
      (deploymentMode !== (skill?.deploymentMode ?? 'symlink') ||
        allowCopyFallback !== (skill?.allowCopyFallback !== false)))

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
              <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
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
                        {skill.category.trim() || 'General'}
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
                        onClick={() => {
                          setEditRevision(skill.revisionId ?? '')
                          setEditing(true)
                        }}
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
                          setFiles(skill.files ?? [])
                          setDeploymentMode(skill.deploymentMode ?? 'symlink')
                          setAllowCopyFallback(
                            skill.allowCopyFallback !== false,
                          )
                          setEditing(false)
                        }}
                      >
                        取消
                      </Button>
                      <Button
                        type="button"
                        size="sm"
                        disabled={
                          !name.trim() || !dirty || saveMutation.isPending
                        }
                        onClick={() => saveMutation.mutate()}
                      >
                        {saveMutation.isPending ? '保存中…' : '保存'}
                      </Button>
                    </>
                  )}
                </div>
              </div>
            </header>

            <section
              aria-label="部署设置"
              className="space-y-3 border-y border-primary-200 py-4"
            >
              <div className="flex flex-wrap items-center justify-between gap-3">
                <h2 className="text-sm font-medium">部署模式</h2>
                {editing ? (
                  <Tabs
                    value={deploymentMode}
                    onValueChange={(value) =>
                      setDeploymentMode(value === 'copy' ? 'copy' : 'symlink')
                    }
                    aria-label="部署模式"
                  >
                    <TabsList>
                      <TabsTab value="symlink">Symlink</TabsTab>
                      <TabsTab value="copy">Copy</TabsTab>
                    </TabsList>
                  </Tabs>
                ) : (
                  <span className="font-mono text-sm">
                    {skill.deploymentMode === 'copy' ? 'Copy' : 'Symlink'}
                  </span>
                )}
              </div>
              {(editing
                ? deploymentMode === 'symlink'
                : skill.deploymentMode !== 'copy') && (
                <label className="flex items-center justify-between gap-3 text-sm text-primary-500">
                  允许 Copy 降级
                  <Switch
                    checked={allowCopyFallback}
                    disabled={!editing || saveMutation.isPending}
                    onCheckedChange={setAllowCopyFallback}
                    aria-label="允许 Copy 降级"
                  />
                </label>
              )}
            </section>

            <SkillFilesPanel
              content={content}
              files={files}
              editing={editing}
              onContentChange={setContent}
              onFilesChange={setFiles}
            />

            <section className="rounded-2xl border border-primary-200 bg-primary-50/70 p-4 sm:p-5">
              <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
                <h2 className="text-xs font-medium uppercase tracking-wider text-primary-500">
                  已绑定智能体 ({bindings.length})
                </h2>
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  disabled={editing || operationMutation.isPending}
                  onClick={() => operationMutation.mutate({ action: 'sync' })}
                >
                  <HugeiconsIcon icon={RefreshIcon} size={14} />
                  {operationMutation.isPending ? '同步中…' : '同步'}
                </Button>
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
                <p className="text-sm text-primary-500">尚未绑定任何智能体。</p>
              ) : (
                <ul className="space-y-2">
                  {bindings.map((binding) => {
                    const agent = agents.find(
                      (a) => agentIdOf(a) === binding.agentId,
                    )
                    const deployment = detailQuery.data?.deployments?.find(
                      (entry) => entry.agentId === binding.agentId,
                    )
                    const statusLabels: Record<string, string> = {
                      'in-sync': '已同步',
                      conflict: '内容冲突',
                      'external-visible': '外部目录，尚未接管',
                      error: '同步失败',
                      pending: '同步中',
                      unsupported: '暂不支持交付',
                      'prompt-only': '仅 Prompt 注入',
                    }
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
                          <p className="mt-1 break-all text-xs text-primary-500">
                            {deployment?.actualMode
                              ? `${deployment.actualMode === 'symlink' ? 'Symlink' : 'Copy'} · `
                              : ''}
                            {deployment
                              ? (statusLabels[deployment.status] ??
                                deployment.status)
                              : '待同步'}
                            {deployment?.delivery === 'on-demand'
                              ? ' · 隔离文件包，按需加载'
                              : ''}
                          </p>
                          {deployment?.message && (
                            <p className="mt-1 break-words text-xs text-danger">
                              {deployment.message}
                            </p>
                          )}
                          {deployment?.hash &&
                            ['conflict', 'external-visible'].includes(
                              deployment.status,
                            ) && (
                              <div className="mt-2 flex flex-wrap gap-2">
                                <Button
                                  size="sm"
                                  variant="outline"
                                  disabled={
                                    operationMutation.isPending || editing
                                  }
                                  onClick={() =>
                                    operationMutation.mutate({
                                      action: 'publish-local',
                                      agentId: binding.agentId,
                                      observedHash: deployment.hash,
                                    })
                                  }
                                >
                                  采用此副本并发布
                                </Button>
                                <Button
                                  size="sm"
                                  variant="outline"
                                  disabled={
                                    operationMutation.isPending || editing
                                  }
                                  onClick={() =>
                                    operationMutation.mutate({
                                      action: 'use-catalog',
                                      agentId: binding.agentId,
                                      observedHash: deployment.hash,
                                    })
                                  }
                                >
                                  采用平台版本
                                </Button>
                              </div>
                            )}
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

            <section className="space-y-2 border-t border-primary-200 pt-4">
              <h2 className="text-sm font-medium">版本历史</h2>
              {(detailQuery.data?.revisions ?? []).map((revision) => (
                <div
                  key={revision.id}
                  className="flex flex-wrap items-center justify-between gap-2 text-xs"
                >
                  <span className="min-w-0 break-all text-primary-500">
                    {new Date(revision.createdAt).toLocaleString()} ·{' '}
                    {revision.hash.slice(0, 12)}
                  </span>
                  {revision.id === skill.revisionId ? (
                    <span>当前版本</span>
                  ) : (
                    <Button
                      size="sm"
                      variant="ghost"
                      disabled={editing || operationMutation.isPending}
                      onClick={() =>
                        operationMutation.mutate({
                          action: 'restore',
                          revisionId: revision.id,
                        })
                      }
                    >
                      恢复
                    </Button>
                  )}
                </div>
              ))}
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
