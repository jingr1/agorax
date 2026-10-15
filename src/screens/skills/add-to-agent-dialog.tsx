/**
 * Multica-style "Add to agent" multi-select dialog.
 */
import { useMemo, useState } from 'react'
import { HugeiconsIcon } from '@hugeicons/react'
import {
  ArrowDown01Icon,
  Cancel01Icon,
  Search01Icon,
} from '@hugeicons/core-free-icons'
import { Button } from '@/components/ui/button'
import {
  DialogContent,
  DialogRoot,
  DialogTitle,
} from '@/components/ui/dialog'
import { AgentIdentityAvatar } from '@/components/avatars'
import { cn } from '@/lib/utils'

export type AddToAgentTarget = {
  agentId: string
  name: string
  displayName?: string
  runtime?: string
  /** True when this agent already has the skill bound. */
  alreadyBound?: boolean
}

function agentLabel(agent: AddToAgentTarget): string {
  return agent.displayName || agent.name || agent.agentId
}

function AgentGroup({
  label,
  agents,
  selectedIds,
  onToggle,
  defaultOpen = true,
}: {
  label: string
  agents: Array<AddToAgentTarget>
  selectedIds: ReadonlySet<string>
  onToggle: (agent: AddToAgentTarget) => void
  defaultOpen?: boolean
}) {
  const [open, setOpen] = useState(defaultOpen)
  if (agents.length === 0) return null
  return (
    <div className="mb-1">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center gap-1.5 px-2 py-1.5 text-left text-xs font-medium text-primary-500"
      >
        <HugeiconsIcon
          icon={ArrowDown01Icon}
          size={12}
          className={cn(
            'transition-transform',
            !open && '-rotate-90',
          )}
        />
        {label} {agents.length}
      </button>
      {open ? (
        <ul className="space-y-0.5">
          {agents.map((agent) => {
            const checked =
              agent.alreadyBound || selectedIds.has(agent.agentId)
            const disabled = Boolean(agent.alreadyBound)
            return (
              <li key={agent.agentId}>
                <label
                  className={cn(
                    'flex cursor-pointer items-center gap-2.5 rounded-lg px-2 py-2 hover:bg-primary-100/60',
                    disabled && 'cursor-default opacity-60',
                  )}
                >
                  <input
                    type="checkbox"
                    className="h-4 w-4"
                    checked={checked}
                    disabled={disabled}
                    onChange={() => {
                      if (!disabled) onToggle(agent)
                    }}
                  />
                  <AgentIdentityAvatar
                    name={agentLabel(agent)}
                    runtime={agent.runtime}
                    size={28}
                  />
                  <span className="min-w-0 flex-1 truncate text-sm text-ink">
                    {agentLabel(agent)}
                    {agent.runtime ? (
                      <span className="ml-1.5 text-[11px] text-primary-500">
                        {agent.runtime}
                      </span>
                    ) : null}
                  </span>
                </label>
              </li>
            )
          })}
        </ul>
      ) : null}
    </div>
  )
}

export function AddToAgentDialog({
  open,
  onOpenChange,
  skillName,
  agents,
  onConfirm,
  saving = false,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  skillName: string
  agents: Array<AddToAgentTarget>
  onConfirm: (agentIds: Array<string>) => void | Promise<void>
  saving?: boolean
}) {
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set())
  const [query, setQuery] = useState('')

  const handleOpenChange = (next: boolean) => {
    if (saving) return
    if (!next) {
      setSelectedIds(new Set())
      setQuery('')
    }
    onOpenChange(next)
  }

  const trimmed = query.trim().toLowerCase()
  const filtered = useMemo(() => {
    if (!trimmed) return agents
    return agents.filter((a) =>
      agentLabel(a).toLowerCase().includes(trimmed),
    )
  }, [agents, trimmed])

  const hermes = filtered.filter((a) => a.runtime === 'hermes')
  const managed = filtered.filter((a) => a.runtime !== 'hermes')
  const count = selectedIds.size

  const toggle = (agent: AddToAgentTarget) => {
    setSelectedIds((prev) => {
      const next = new Set(prev)
      if (next.has(agent.agentId)) next.delete(agent.agentId)
      else next.add(agent.agentId)
      return next
    })
  }

  return (
    <DialogRoot open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="flex h-[32rem] max-h-[85svh] w-[min(480px,92vw)] flex-col border-primary-200 bg-primary-50/95 p-0 backdrop-blur-sm">
        <div className="flex items-start justify-between gap-2 border-b border-primary-200 px-5 py-4">
          <div className="min-w-0">
            <DialogTitle>添加到智能体</DialogTitle>
            <span className="mt-1.5 inline-flex max-w-full truncate rounded-md bg-primary-100 px-2 py-0.5 text-xs text-primary-600">
              {skillName}
            </span>
          </div>
          <button
            type="button"
            aria-label="关闭"
            className="rounded-md p-1 text-primary-500 hover:bg-primary-100 hover:text-ink"
            onClick={() => handleOpenChange(false)}
            disabled={saving}
          >
            <HugeiconsIcon icon={Cancel01Icon} size={16} />
          </button>
        </div>

        <div className="flex min-h-0 flex-1 flex-col gap-3 px-5 py-3">
          {agents.length > 0 ? (
            <div className="relative">
              <HugeiconsIcon
                icon={Search01Icon}
                size={14}
                className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-primary-400"
              />
              <input
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="搜索智能体…"
                className="h-8 w-full rounded-lg border border-primary-200 bg-primary-50 pl-8 pr-3 text-sm outline-none focus:border-primary"
              />
            </div>
          ) : null}

          <div className="min-h-0 flex-1 overflow-y-auto rounded-xl border border-primary-200 bg-primary-100/30 p-1.5">
            {agents.length === 0 ? (
              <p className="py-8 text-center text-sm text-primary-500">
                暂无可用智能体
              </p>
            ) : filtered.length === 0 ? (
              <p className="py-8 text-center text-sm text-primary-500">
                没有匹配的智能体
              </p>
            ) : (
              <>
                <AgentGroup
                  label="Hermes"
                  agents={hermes}
                  selectedIds={selectedIds}
                  onToggle={toggle}
                  defaultOpen
                />
                <AgentGroup
                  label="Managed"
                  agents={managed}
                  selectedIds={selectedIds}
                  onToggle={toggle}
                  defaultOpen={Boolean(trimmed)}
                />
              </>
            )}
          </div>
        </div>

        <div className="flex items-center justify-between gap-2 border-t border-primary-200 px-5 py-3">
          <Button
            type="button"
            variant="ghost"
            size="sm"
            disabled={saving}
            onClick={() => handleOpenChange(false)}
          >
            取消
          </Button>
          <Button
            type="button"
            size="sm"
            disabled={saving || count === 0}
            onClick={() => void onConfirm([...selectedIds])}
          >
            {saving ? '添加中…' : `添加 (${count})`}
          </Button>
        </div>
      </DialogContent>
    </DialogRoot>
  )
}
