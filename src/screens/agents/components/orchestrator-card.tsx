import { useState } from 'react'
import { useNavigate } from '@tanstack/react-router'
import {
  Cancel01Icon,
  Chatting01Icon,
  Settings01Icon,
} from '@hugeicons/core-free-icons'
import { HugeiconsIcon } from '@hugeicons/react'
import { AgentProgress } from '@/components/agent-view/agent-progress'
import { AgentIdentityAvatar } from '@/components/avatars'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'

const ORCHESTRATOR_NAME_KEY = 'operations:orchestrator:name'
const DEFAULT_ORCHESTRATOR_NAME = 'Main Agent'

export function OrchestratorCard({ totalAgents }: { totalAgents: number }) {
  const navigate = useNavigate()
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [orchestratorName, setOrchestratorName] = useState(() => {
    if (typeof window === 'undefined') return DEFAULT_ORCHESTRATOR_NAME
    return (
      window.localStorage.getItem(ORCHESTRATOR_NAME_KEY) ||
      DEFAULT_ORCHESTRATOR_NAME
    )
  })
  const [draftName, setDraftName] = useState(orchestratorName)

  const openSettings = () => {
    setDraftName(orchestratorName)
    setSettingsOpen(true)
  }

  const saveSettings = () => {
    const nextName = draftName.trim() || DEFAULT_ORCHESTRATOR_NAME
    window.localStorage.setItem(ORCHESTRATOR_NAME_KEY, nextName)
    setOrchestratorName(nextName)
    setDraftName(nextName)
    setSettingsOpen(false)
  }

  return (
    <>
      <article className="flex items-center gap-4 rounded-2xl border border-[var(--theme-border)] border-l-4 border-l-[var(--theme-accent)] bg-[var(--theme-card)] px-5 py-4 shadow-[0_20px_60px_color-mix(in_srgb,var(--theme-shadow)_10%,transparent)]">
        <div className="relative flex size-12 shrink-0 items-center justify-center">
          <AgentProgress
            value={82}
            status="running"
            size={48}
            strokeWidth={2.5}
            className="text-emerald-500"
          />
          <div className="absolute inset-0 flex items-center justify-center">
            <AgentIdentityAvatar
              name={orchestratorName}
              runtime="hermes"
              providerSiblingCount={Math.max(2, totalAgents)}
              size={40}
            />
          </div>
        </div>

        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <h2 className="text-base font-semibold text-[var(--theme-text)]">
              {orchestratorName}
            </h2>
            <span
              className={cn(
                'h-2 w-2 rounded-full bg-emerald-500',
                totalAgents > 0 && 'animate-pulse',
              )}
              aria-label="Active"
              title="Active"
            />
          </div>
          <p className="mt-0.5 text-sm text-[var(--theme-muted)]">
            Orchestrator · {totalAgents} agents reporting
          </p>
        </div>

        <div className="flex items-center gap-2">
          <Button
            size="sm"
            variant="secondary"
            className="h-9 gap-1.5 rounded-xl border border-transparent bg-[var(--theme-input)] px-3 text-xs font-medium text-[var(--theme-text)] hover:bg-[var(--theme-card2)]"
            onClick={() => void navigate({ to: '/chat' })}
          >
            <HugeiconsIcon icon={Chatting01Icon} size={14} strokeWidth={1.9} />
            Open chat
          </Button>
          <button
            type="button"
            onClick={openSettings}
            className="inline-flex h-9 w-9 items-center justify-center rounded-xl text-[var(--theme-muted)] transition-colors hover:bg-[var(--theme-bg)] hover:text-[var(--theme-text)]"
            aria-label="Orchestrator settings"
            title="Orchestrator settings"
          >
            <HugeiconsIcon icon={Settings01Icon} size={16} strokeWidth={1.8} />
          </button>
        </div>
      </article>

      {settingsOpen ? (
        <div
          className="overlay-scrim fixed inset-0 z-50 flex items-center justify-center bg-[color-mix(in_srgb,var(--theme-bg)_48%,transparent)] px-4 py-6"
          onClick={() => setSettingsOpen(false)}
        >
          <div
            className="w-full max-w-md rounded-3xl border border-[var(--theme-border2)] bg-[var(--theme-card)] p-6 shadow-[0_30px_100px_var(--theme-shadow)]"
            onClick={(event) => event.stopPropagation()}
          >
            <div className="flex items-start justify-between gap-4">
              <div className="flex items-start gap-3">
                <div className="flex size-11 items-center justify-center rounded-2xl border border-[var(--theme-border)] bg-[var(--theme-bg)] text-[var(--theme-accent)]">
                  <HugeiconsIcon
                    icon={Settings01Icon}
                    size={20}
                    strokeWidth={1.8}
                  />
                </div>
                <div>
                  <h2 className="text-xl font-semibold text-[var(--theme-text)]">
                    Orchestrator Settings
                  </h2>
                  <p className="mt-1 text-sm text-[var(--theme-muted-2)]">
                    Update the display name used on this card.
                  </p>
                </div>
              </div>
              <button
                type="button"
                onClick={() => setSettingsOpen(false)}
                className="inline-flex size-10 items-center justify-center rounded-xl border border-[var(--theme-border)] bg-[var(--theme-card2)] text-[var(--theme-muted)] transition-colors hover:border-[var(--theme-accent)] hover:text-[var(--theme-accent-strong)]"
                aria-label="Close orchestrator settings"
              >
                <HugeiconsIcon
                  icon={Cancel01Icon}
                  size={18}
                  strokeWidth={1.8}
                />
              </button>
            </div>

            <label className="mt-6 block space-y-2">
              <span className="text-sm font-medium text-[var(--theme-text)]">
                Display name
              </span>
              <input
                value={draftName}
                onChange={(event) => setDraftName(event.target.value)}
                placeholder={DEFAULT_ORCHESTRATOR_NAME}
                className="w-full rounded-2xl field-surface px-4 py-3 text-sm text-[var(--theme-text)] outline-none focus:border-[var(--theme-accent)]"
              />
            </label>

            <div className="mt-6 flex items-center justify-end gap-3">
              <Button
                type="button"
                variant="secondary"
                onClick={() => setSettingsOpen(false)}
              >
                Close
              </Button>
              <Button type="button" onClick={saveSettings}>
                Save
              </Button>
            </div>
          </div>
        </div>
      ) : null}
    </>
  )
}
