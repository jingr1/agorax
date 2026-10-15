/**
 * Multica-style create-skill chooser:
 * 手动创建 / 从本地导入 / 从 URL 导入 / 从 Agent 已有的 skill 复制
 */
import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type ChangeEvent,
} from 'react'
import { HugeiconsIcon } from '@hugeicons/react'
import {
  AiComputerIcon,
  ArrowLeft01Icon,
  ArrowRight01Icon,
  Download01Icon,
  Folder01Icon,
  PlusSignIcon,
} from '@hugeicons/core-free-icons'
import { Button } from '@/components/ui/button'
import {
  DialogContent,
  DialogDescription,
  DialogRoot,
  DialogTitle,
} from '@/components/ui/dialog'
import { toast } from '@/components/ui/toast'
import { cn } from '@/lib/utils'

type Method = 'chooser' | 'manual' | 'local' | 'url' | 'agent'

type CreatedSkill = {
  id: string
  name: string
  description?: string
}

type AgentSummary = {
  agentId: string
  id?: string
  name?: string
  displayName?: string
  runtime?: string
}

type LocalSkillRow = {
  name: string
  description: string
  path: string
  platformManaged: boolean
  alreadyInCatalog: boolean
}

type PreparedLocal = {
  ok: true
  source: 'folder' | 'archive'
  displayName: string
  skillName: string
  description: string
  fileCount: number
  files?: Array<{ path: string; content: string }>
  archiveFile?: File
} | {
  ok: false
  error: string
}

async function fetchJson<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, {
    ...init,
    headers: {
      ...(init?.body instanceof FormData
        ? {}
        : { 'Content-Type': 'application/json' }),
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

function agentIdOf(agent: AgentSummary): string {
  return agent.agentId || agent.id || ''
}

function agentLabel(agent: AgentSummary): string {
  return agent.displayName || agent.name || agentIdOf(agent)
}

function normalizeRelPath(raw: string): string {
  return raw.replace(/\\/g, '/').replace(/^\.\/+/, '').replace(/^\/+/, '')
}

function isSkillMd(path: string): boolean {
  return /(?:^|\/)skill\.md$/i.test(path)
}

async function prepareFromFolderFiles(files: File[]): Promise<PreparedLocal> {
  if (files.length === 0) {
    return { ok: false, error: '文件夹是空的。' }
  }
  const entries: Array<{ path: string; file: File }> = []
  for (const file of files) {
    const rel =
      typeof file.webkitRelativePath === 'string' && file.webkitRelativePath
        ? file.webkitRelativePath
        : file.name
    const path = normalizeRelPath(rel)
    if (!path || path.includes('node_modules') || path.includes('.git/')) {
      continue
    }
    entries.push({ path, file })
  }
  if (entries.length === 0) {
    return { ok: false, error: '文件夹是空的。' }
  }

  let skillEntry: { path: string; file: File } | null = null
  let prefix = ''
  for (const entry of entries) {
    if (!isSkillMd(entry.path)) continue
    const idx = entry.path.toLowerCase().lastIndexOf('skill.md')
    const p = entry.path.slice(0, idx)
    if (!skillEntry || p.length < prefix.length) {
      skillEntry = entry
      prefix = p
    }
  }
  if (!skillEntry) {
    return { ok: false, error: '这个文件夹不是 skill——里面没有 SKILL.md。' }
  }

  const out: Array<{ path: string; content: string }> = []
  for (const entry of entries) {
    if (prefix && !entry.path.startsWith(prefix)) continue
    const rel = prefix ? entry.path.slice(prefix.length) : entry.path
    if (!rel || rel.endsWith('/')) continue
    if (/\.(png|jpe?g|gif|webp|pdf|zip|woff2?)$/i.test(rel)) continue
    if (entry.file.size > 1 << 20) continue
    const content = await entry.file.text()
    out.push({ path: rel, content })
  }
  const skillMd = out.find((f) => isSkillMd(f.path))
  if (!skillMd) {
    return { ok: false, error: '这个文件夹不是 skill——里面没有 SKILL.md。' }
  }
  const nameMatch = skillMd.content.match(/^name:\s*(.+?)\s*$/m)
  const descMatch = skillMd.content.match(/^description:\s*(.+?)\s*$/m)
  const wrapper =
    prefix.replace(/\/+$/, '').split('/').filter(Boolean).pop() || 'skill'
  return {
    ok: true,
    source: 'folder',
    displayName: wrapper,
    skillName:
      nameMatch?.[1]?.trim().replace(/^["']|["']$/g, '') || wrapper,
    description:
      descMatch?.[1]?.trim().replace(/^["']|["']$/g, '') || '',
    fileCount: out.length,
    files: out,
  }
}

function prepareFromArchiveFile(file: File): PreparedLocal {
  if (file.size > 16 << 20) {
    return { ok: false, error: '这个 skill 太大，无法导入。' }
  }
  const base = file.name.replace(/\\/g, '/').split('/').pop() || file.name
  const skillName = base.replace(/\.(zip|skill)$/i, '') || 'skill'
  return {
    ok: true,
    source: 'archive',
    displayName: base,
    skillName,
    description: '',
    fileCount: 0,
    archiveFile: file,
  }
}

function MethodChooser({ onChoose }: { onChoose: (m: Method) => void }) {
  const methods: Array<{
    key: Exclude<Method, 'chooser'>
    icon: typeof PlusSignIcon
    title: string
    desc: string
  }> = [
    {
      key: 'manual',
      icon: PlusSignIcon,
      title: '手动创建',
      desc: '从空白 SKILL.md 开始写。',
    },
    {
      key: 'local',
      icon: Folder01Icon,
      title: '从本地导入',
      desc: '选择包含 SKILL.md 的文件夹，或 .skill / .zip 压缩包。',
    },
    {
      key: 'url',
      icon: Download01Icon,
      title: '从 URL 导入',
      desc: '通过 URL 拉取已发布的 skill。',
    },
    {
      key: 'agent',
      icon: AiComputerIcon,
      title: '从 Agent 已有的 skill 复制',
      desc: '把某个 Agent 本地已装好的 skill 提升到工作区目录。',
    },
  ]

  return (
    <div className="grid gap-2">
      {methods.map(({ key, icon, title, desc }) => (
        <button
          key={key}
          type="button"
          onClick={() => onChoose(key)}
          className="group flex items-start gap-3 rounded-xl border border-primary-200 bg-primary-50/60 p-4 text-left transition-colors hover:border-accent/40 hover:bg-accent/10"
        >
          <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-primary-100 text-primary-600">
            <HugeiconsIcon icon={icon} size={18} strokeWidth={1.8} />
          </div>
          <div className="min-w-0 flex-1">
            <div className="text-sm font-medium text-ink">{title}</div>
            <div className="mt-0.5 text-xs text-primary-500">{desc}</div>
          </div>
          <HugeiconsIcon
            icon={ArrowRight01Icon}
            size={16}
            className="mt-1 shrink-0 text-primary-400 group-hover:text-primary-600"
          />
        </button>
      ))}
    </div>
  )
}

function ManualForm({
  onCancel,
  onCreated,
}: {
  onCancel: () => void
  onCreated: (skill: CreatedSkill) => void
}) {
  const [name, setName] = useState('')
  const [description, setDescription] = useState('')
  const [content, setContent] = useState('')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')

  const submit = async () => {
    if (!name.trim()) return
    setLoading(true)
    setError('')
    try {
      const payload = await fetchJson<{ skill: CreatedSkill }>(
        '/api/platform-skills',
        {
          method: 'POST',
          body: JSON.stringify({
            name: name.trim(),
            description,
            content: content || `# ${name.trim()}\n`,
            origin: { kind: 'manual' },
          }),
        },
      )
      toast(`已创建 skill：${payload.skill.name}`, { type: 'success' })
      onCreated(payload.skill)
    } catch (err) {
      setError(err instanceof Error ? err.message : '创建 skill 失败')
      setLoading(false)
    }
  }

  return (
    <>
      <div className="flex flex-col gap-3">
        <label className="flex flex-col gap-1 text-sm">
          名称
          <input
            autoFocus
            value={name}
            onChange={(e) => {
              setName(e.target.value)
              setError('')
            }}
            className="h-9 rounded-lg border border-primary-200 bg-primary-50 px-3"
            placeholder="例如：review-helper"
          />
          <span className="text-xs text-primary-500">工作区内必须唯一。</span>
        </label>
        <label className="flex flex-col gap-1 text-sm">
          描述
          <input
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            className="h-9 rounded-lg border border-primary-200 bg-primary-50 px-3"
            placeholder="用一句话说什么时候应该把这个 skill 分配给智能体。"
          />
        </label>
        <label className="flex flex-col gap-1 text-sm">
          SKILL.md
          <textarea
            value={content}
            onChange={(e) => setContent(e.target.value)}
            rows={8}
            className="rounded-lg border border-primary-200 bg-primary-50 px-3 py-2 font-mono text-xs"
            placeholder={'# review-helper\n\nInstructions…'}
          />
        </label>
        {error ? (
          <p className="rounded-lg bg-danger/10 px-3 py-2 text-xs text-danger">
            {error}
          </p>
        ) : null}
      </div>
      <div className="mt-4 flex justify-end gap-2">
        <Button type="button" variant="ghost" onClick={onCancel} disabled={loading}>
          取消
        </Button>
        <Button
          type="button"
          disabled={!name.trim() || loading}
          onClick={() => void submit()}
        >
          {loading ? '创建中…' : '创建 skill'}
        </Button>
      </div>
    </>
  )
}

function LocalForm({
  prepared,
  preparing,
  onCancel,
  onCreated,
  onChooseFolder,
  onChooseArchive,
}: {
  prepared: PreparedLocal | null
  preparing: boolean
  onCancel: () => void
  onCreated: (skill: CreatedSkill) => void
  onChooseFolder: () => void
  onChooseArchive: () => void
}) {
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')

  const submit = async () => {
    if (!prepared || !prepared.ok) return
    setLoading(true)
    setError('')
    try {
      let payload: { skill: CreatedSkill }
      if (prepared.archiveFile) {
        const form = new FormData()
        form.append('file', prepared.archiveFile)
        payload = await fetchJson<{ skill: CreatedSkill }>(
          '/api/platform-skills/import',
          { method: 'POST', body: form },
        )
      } else {
        payload = await fetchJson<{ skill: CreatedSkill }>(
          '/api/platform-skills/import',
          {
            method: 'POST',
            body: JSON.stringify({ files: prepared.files }),
          },
        )
      }
      toast(`已导入 skill：${payload.skill.name}`, { type: 'success' })
      onCreated(payload.skill)
    } catch (err) {
      setError(err instanceof Error ? err.message : '导入失败')
      setLoading(false)
    }
  }

  const displayError =
    error ||
    (prepared && !prepared.ok ? prepared.error : '') ||
    ''

  return (
    <>
      <div className="flex flex-col gap-3">
        {preparing ? (
          <p className="text-sm text-primary-500">正在读取文件…</p>
        ) : null}
        {prepared?.ok ? (
          <div className="rounded-xl border border-primary-200 bg-primary-50/80 px-3 py-2.5">
            <div className="text-xs text-primary-500">
              {prepared.source === 'archive' ? '压缩包' : '文件夹'}
            </div>
            <div className="mt-0.5 truncate text-sm font-medium text-ink">
              {prepared.displayName}
            </div>
            <div className="mt-2 text-sm font-medium">{prepared.skillName}</div>
            {prepared.description ? (
              <p className="mt-0.5 text-xs text-primary-500">
                {prepared.description}
              </p>
            ) : null}
            {prepared.fileCount > 0 ? (
              <p className="mt-0.5 text-xs text-primary-500">
                {prepared.fileCount} 个文件
              </p>
            ) : null}
          </div>
        ) : null}
        <div className="grid grid-cols-2 gap-2">
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={onChooseFolder}
            disabled={loading || preparing}
          >
            选择文件夹
          </Button>
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={onChooseArchive}
            disabled={loading || preparing}
          >
            选择 .skill / .zip
          </Button>
        </div>
        {displayError ? (
          <p className="rounded-lg bg-danger/10 px-3 py-2 text-xs text-danger">
            {displayError}
          </p>
        ) : null}
      </div>
      <div className="mt-4 flex justify-end gap-2">
        <Button type="button" variant="ghost" onClick={onCancel} disabled={loading}>
          取消
        </Button>
        <Button
          type="button"
          disabled={!prepared?.ok || loading || preparing}
          onClick={() => void submit()}
        >
          {loading ? '导入中…' : '导入'}
        </Button>
      </div>
    </>
  )
}

function UrlForm({
  onCancel,
  onCreated,
}: {
  onCancel: () => void
  onCreated: (skill: CreatedSkill) => void
}) {
  const [url, setUrl] = useState('')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')

  const source = useMemo(() => {
    const u = url.trim().toLowerCase()
    if (u.includes('clawhub.ai')) return 'clawhub'
    if (u.includes('skills.sh')) return 'skills.sh'
    if (u.includes('github.com')) return 'github'
    return null
  }, [url])

  const submit = async () => {
    if (!url.trim()) return
    setLoading(true)
    setError('')
    try {
      const payload = await fetchJson<{ skill: CreatedSkill }>(
        '/api/platform-skills/import',
        {
          method: 'POST',
          body: JSON.stringify({ url: url.trim() }),
        },
      )
      toast(`已导入 skill：${payload.skill.name}`, { type: 'success' })
      onCreated(payload.skill)
    } catch (err) {
      setError(err instanceof Error ? err.message : '导入失败')
      setLoading(false)
    }
  }

  const submittingLabel = loading
    ? source === 'clawhub'
      ? '正在从 ClawHub 导入…'
      : source === 'skills.sh'
        ? '正在从 Skills.sh 导入…'
        : source === 'github'
          ? '正在从 GitHub 导入…'
          : '导入中…'
    : '导入'

  return (
    <>
      <div className="flex flex-col gap-3">
        <label className="flex flex-col gap-1 text-sm">
          Skill URL
          <input
            autoFocus
            value={url}
            onChange={(e) => {
              setUrl(e.target.value)
              setError('')
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter') void submit()
            }}
            className="h-9 rounded-lg border border-primary-200 bg-primary-50 px-3 font-mono text-sm"
            placeholder="https://clawhub.ai/owner/skill"
          />
        </label>
        <div>
          <p className="mb-2 text-xs text-primary-500">支持的来源</p>
          <div className="grid grid-cols-3 gap-2">
            {(
              [
                ['ClawHub', 'clawhub.ai', 'clawhub'],
                ['Skills.sh', 'skills.sh', 'skills.sh'],
                ['GitHub', 'github.com', 'github'],
              ] as const
            ).map(([label, host, key]) => (
              <div
                key={key}
                className={cn(
                  'rounded-lg border px-3 py-2.5',
                  source === key
                    ? 'border-accent bg-accent/10'
                    : 'border-primary-200',
                )}
              >
                <div className="text-xs font-medium text-ink">{label}</div>
                <div className="mt-0.5 truncate font-mono text-[11px] text-primary-500">
                  {host}
                </div>
              </div>
            ))}
          </div>
        </div>
        {error ? (
          <p className="rounded-lg bg-danger/10 px-3 py-2 text-xs text-danger">
            {error}
          </p>
        ) : null}
      </div>
      <div className="mt-4 flex justify-end gap-2">
        <Button type="button" variant="ghost" onClick={onCancel} disabled={loading}>
          取消
        </Button>
        <Button
          type="button"
          disabled={!url.trim() || loading}
          onClick={() => void submit()}
        >
          {submittingLabel}
        </Button>
      </div>
    </>
  )
}

function AgentCopyForm({
  agents,
  onCancel,
  onCreated,
}: {
  agents: Array<AgentSummary>
  onCancel: () => void
  onCreated: (skill: CreatedSkill) => void
}) {
  const [agentId, setAgentId] = useState('')
  const [skills, setSkills] = useState<Array<LocalSkillRow>>([])
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [loadingList, setLoadingList] = useState(false)
  const [loadingImport, setLoadingImport] = useState(false)
  const [error, setError] = useState('')
  const [search, setSearch] = useState('')

  useEffect(() => {
    if (!agentId) {
      setSkills([])
      setSelected(new Set())
      return
    }
    let cancelled = false
    setLoadingList(true)
    setError('')
    void fetchJson<{ skills: Array<LocalSkillRow> }>(
      `/api/agents/${encodeURIComponent(agentId)}/local-skills`,
    )
      .then((payload) => {
        if (cancelled) return
        setSkills(payload.skills ?? [])
        setSelected(new Set())
      })
      .catch((err) => {
        if (cancelled) return
        setSkills([])
        setError(err instanceof Error ? err.message : '加载本地 skill 失败')
      })
      .finally(() => {
        if (!cancelled) setLoadingList(false)
      })
    return () => {
      cancelled = true
    }
  }, [agentId])

  const visible = useMemo(() => {
    const q = search.trim().toLowerCase()
    const list = skills.filter(
      (s) => !s.platformManaged && !s.alreadyInCatalog,
    )
    if (!q) return list
    return list.filter(
      (s) =>
        s.name.toLowerCase().includes(q) ||
        s.description.toLowerCase().includes(q),
    )
  }, [skills, search])

  const toggle = (name: string) => {
    setSelected((prev) => {
      const next = new Set(prev)
      if (next.has(name)) next.delete(name)
      else next.add(name)
      return next
    })
  }

  const submit = async () => {
    if (!agentId || selected.size === 0) return
    setLoadingImport(true)
    setError('')
    try {
      const payload = await fetchJson<{
        created: Array<CreatedSkill>
        skipped: Array<{ name: string; reason: string }>
      }>(`/api/agents/${encodeURIComponent(agentId)}/local-skills`, {
        method: 'POST',
        body: JSON.stringify({ skillNames: [...selected] }),
      })
      const created = payload.created ?? []
      if (created.length === 0) {
        const reason =
          payload.skipped?.[0]?.reason || '没有可导入的 skill'
        throw new Error(reason)
      }
      toast(
        created.length === 1
          ? `已复制 skill：${created[0].name}`
          : `已复制 ${created.length} 个 skill`,
        { type: 'success' },
      )
      onCreated(created[0])
    } catch (err) {
      setError(err instanceof Error ? err.message : '复制失败')
      setLoadingImport(false)
    }
  }

  return (
    <>
      <div className="flex flex-col gap-3">
        <label className="flex flex-col gap-1 text-sm">
          Agent
          <select
            value={agentId}
            onChange={(e) => setAgentId(e.target.value)}
            className="h-9 rounded-lg border border-primary-200 bg-primary-50 px-3"
          >
            <option value="">选择一个 Agent</option>
            {agents.map((agent) => {
              const id = agentIdOf(agent)
              return (
                <option key={id} value={id}>
                  {agentLabel(agent)}
                  {agent.runtime ? ` (${agent.runtime})` : ''}
                </option>
              )
            })}
          </select>
        </label>

        {!agentId ? (
          <p className="text-sm text-primary-500">请选择一个 Agent 继续</p>
        ) : loadingList ? (
          <p className="text-sm text-primary-500">加载中…</p>
        ) : (
          <>
            <input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="搜索本地 skill…"
              className="h-9 rounded-lg border border-primary-200 bg-primary-50 px-3 text-sm"
            />
            {visible.length === 0 ? (
              <p className="rounded-xl border border-dashed border-primary-200 px-3 py-6 text-center text-sm text-primary-500">
                未找到可复制的本地 skill（已在目录中或平台托管的已过滤）。
              </p>
            ) : (
              <ul className="max-h-56 space-y-1 overflow-y-auto rounded-xl border border-primary-200 p-2">
                {visible.map((skill) => {
                  const checked = selected.has(skill.name)
                  return (
                    <li key={skill.name}>
                      <label className="flex cursor-pointer items-start gap-2 rounded-lg px-2 py-2 hover:bg-primary-50">
                        <input
                          type="checkbox"
                          className="mt-1"
                          checked={checked}
                          onChange={() => toggle(skill.name)}
                        />
                        <span className="min-w-0">
                          <span className="block text-sm font-medium text-ink">
                            {skill.name}
                          </span>
                          {skill.description ? (
                            <span className="block text-xs text-primary-500">
                              {skill.description}
                            </span>
                          ) : null}
                        </span>
                      </label>
                    </li>
                  )
                })}
              </ul>
            )}
          </>
        )}

        {error ? (
          <p className="rounded-lg bg-danger/10 px-3 py-2 text-xs text-danger">
            {error}
          </p>
        ) : null}
      </div>
      <div className="mt-4 flex justify-end gap-2">
        <Button
          type="button"
          variant="ghost"
          onClick={onCancel}
          disabled={loadingImport}
        >
          取消
        </Button>
        <Button
          type="button"
          disabled={!agentId || selected.size === 0 || loadingImport}
          onClick={() => void submit()}
        >
          {loadingImport
            ? '复制中…'
            : selected.size > 1
              ? `复制 ${selected.size} 个`
              : '复制到目录'}
        </Button>
      </div>
    </>
  )
}

export function CreateSkillDialog({
  open,
  onOpenChange,
  agents,
  onCreated,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  agents: Array<AgentSummary>
  onCreated?: (skill: CreatedSkill) => void
}) {
  const [method, setMethod] = useState<Method>('chooser')
  const [localPrepared, setLocalPrepared] = useState<PreparedLocal | null>(
    null,
  )
  const [localPreparing, setLocalPreparing] = useState(false)
  const folderInputRef = useRef<HTMLInputElement>(null)
  const archiveInputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    if (!open) {
      setMethod('chooser')
      setLocalPrepared(null)
      setLocalPreparing(false)
    }
  }, [open])

  const handleCreated = (skill: CreatedSkill) => {
    onCreated?.(skill)
    onOpenChange(false)
  }

  const bindDirectoryInput = (el: HTMLInputElement | null) => {
    folderInputRef.current = el
    if (!el) return
    el.setAttribute('webkitdirectory', '')
    el.setAttribute('directory', '')
  }

  const openFolderPicker = () => folderInputRef.current?.click()
  const openArchivePicker = () => archiveInputRef.current?.click()

  const handleChoose = (next: Method) => {
    if (next === 'local') {
      setMethod('local')
      openFolderPicker()
      return
    }
    setLocalPrepared(null)
    setMethod(next)
  }

  const onFolderPicked = async (e: ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(e.target.files ?? [])
    e.target.value = ''
    if (files.length === 0) return
    setMethod('local')
    setLocalPreparing(true)
    setLocalPrepared(null)
    try {
      const prepared = await prepareFromFolderFiles(files)
      setLocalPrepared(prepared)
    } finally {
      setLocalPreparing(false)
    }
  }

  const onArchivePicked = (e: ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    e.target.value = ''
    if (!file) return
    setMethod('local')
    setLocalPrepared(prepareFromArchiveFile(file))
  }

  const title =
    method === 'chooser'
      ? '新建 skill'
      : method === 'manual'
        ? '手动创建'
        : method === 'local'
          ? '从本地导入'
          : method === 'url'
            ? '从 URL 导入'
            : '从 Agent 已有的 skill 复制'

  const description =
    method === 'chooser'
      ? '选择添加 skill 的方式。'
      : method === 'agent'
        ? '浏览 Agent 本地已安装的 skill，提升到工作区平台目录。'
        : null

  return (
    <DialogRoot open={open} onOpenChange={onOpenChange}>
      <DialogContent className="w-[min(520px,92vw)] border-primary-200 bg-primary-50/95 p-5 backdrop-blur-sm">
        <div className="mb-3 flex items-start gap-2">
          {method !== 'chooser' ? (
            <button
              type="button"
              className="mt-0.5 rounded-md p-1 text-primary-500 hover:bg-primary-100 hover:text-ink"
              aria-label="返回方式选择"
              onClick={() => {
                setMethod('chooser')
                setLocalPrepared(null)
              }}
            >
              <HugeiconsIcon icon={ArrowLeft01Icon} size={16} />
            </button>
          ) : null}
          <div className="min-w-0 flex-1">
            <DialogTitle>{title}</DialogTitle>
            {description ? (
              <DialogDescription className="mt-1">
                {description}
              </DialogDescription>
            ) : null}
          </div>
        </div>

        {method === 'chooser' ? (
          <MethodChooser onChoose={handleChoose} />
        ) : null}
        {method === 'manual' ? (
          <ManualForm
            onCancel={() => onOpenChange(false)}
            onCreated={handleCreated}
          />
        ) : null}
        {method === 'local' ? (
          <LocalForm
            prepared={localPrepared}
            preparing={localPreparing}
            onCancel={() => onOpenChange(false)}
            onCreated={handleCreated}
            onChooseFolder={openFolderPicker}
            onChooseArchive={openArchivePicker}
          />
        ) : null}
        {method === 'url' ? (
          <UrlForm
            onCancel={() => onOpenChange(false)}
            onCreated={handleCreated}
          />
        ) : null}
        {method === 'agent' ? (
          <AgentCopyForm
            agents={agents}
            onCancel={() => onOpenChange(false)}
            onCreated={handleCreated}
          />
        ) : null}

        <input
          ref={bindDirectoryInput}
          type="file"
          className="hidden"
          multiple
          onChange={(e) => void onFolderPicked(e)}
        />
        <input
          ref={archiveInputRef}
          type="file"
          accept=".zip,.skill,application/zip"
          className="hidden"
          onChange={onArchivePicked}
        />
      </DialogContent>
    </DialogRoot>
  )
}
