'use client'

import { Button } from '@/components/ui/button'
import { MissionSurface } from './mission-surface'
import { PipelineView } from './pipeline-view'
import { CreateMissionButton } from './components/create-task-button'

type MissionsLayoutProps = {
  selectedMissionId: string | null
  onSelectMission: (missionId: string | null) => void
  /** @deprecated Prefer selectedMissionId */
  selectedTaskId?: string | null
  /** @deprecated Prefer onSelectMission */
  onSelectTask?: (taskId: string | null) => void
}

export function MissionsLayout({
  selectedMissionId,
  onSelectMission,
  selectedTaskId,
  onSelectTask,
}: MissionsLayoutProps) {
  const id = selectedMissionId ?? selectedTaskId ?? null
  const select = onSelectMission ?? onSelectTask ?? (() => {})
  const showDetail = Boolean(id)

  return (
    <div className="flex h-full flex-col bg-[var(--theme-bg)] text-[var(--theme-text)]">
      <header className="shrink-0 border-b border-[var(--theme-border)] bg-[var(--theme-card)] px-4 py-3 sm:px-6">
        <div className="flex items-center justify-between gap-4">
          <div>
            <h1 className="text-lg font-semibold">Missions</h1>
            <p className="text-xs text-[var(--theme-muted)]">
              {showDetail
                ? 'Mission detail — tasks decomposed for agents.'
                : 'Mission board · list · swimlane (no Gantt).'}
            </p>
          </div>
          <div className="flex items-center gap-3">
            {showDetail ? (
              <Button
                type="button"
                variant="secondary"
                size="sm"
                onClick={() => select(null)}
                className="text-xs"
              >
                Back to list
              </Button>
            ) : null}
            <CreateMissionButton />
          </div>
        </div>
      </header>

      <main className="min-h-0 flex-1 overflow-hidden">
        {showDetail ? (
          <PipelineView
            selectedMissionId={id}
            onSelectMission={select}
          />
        ) : (
          <MissionSurface onSelectMission={select} />
        )}
      </main>
    </div>
  )
}

/** @deprecated Use MissionsLayout. */
export const MissionControlLayout = MissionsLayout
export type MissionControlTab = 'board' | 'pipeline'
