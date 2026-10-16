'use client'

import { ArrowLeft01Icon, Target02Icon } from '@hugeicons/core-free-icons'
import { HugeiconsIcon } from '@hugeicons/react'
import { PageHeader } from '@/components/layout/page-header'
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
    <div className="flex h-full flex-col bg-surface text-fg">
      <PageHeader
        variant="bar"
        icon={Target02Icon}
        title="Missions"
        description={
          showDetail
            ? 'Mission detail — tasks decomposed for agents.'
            : 'Mission board · list · swimlane.'
        }
        actions={
          showDetail ? (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={() => select(null)}
            >
              <HugeiconsIcon
                icon={ArrowLeft01Icon}
                size={14}
                strokeWidth={1.8}
              />
              Back to list
            </Button>
          ) : (
            <CreateMissionButton />
          )
        }
      />

      <main className="min-h-0 flex-1 overflow-hidden">
        {showDetail ? (
          <PipelineView selectedMissionId={id} onSelectMission={select} />
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
