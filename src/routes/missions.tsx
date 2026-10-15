import { createFileRoute, useNavigate, useSearch } from '@tanstack/react-router'
import { z } from 'zod'
import { usePageTitle } from '@/hooks/use-page-title'
import { MissionsLayout } from '@/screens/mission-control/mission-control-layout'

const searchSchema = z.object({
  missionId: z.string().optional(),
  /** Legacy alias for mission/card id */
  taskId: z.string().optional(),
})

export const Route = createFileRoute('/missions')({
  ssr: false,
  validateSearch: searchSchema,
  component: MissionsRoute,
})

function MissionsRoute() {
  usePageTitle('Missions')
  const search = useSearch({ from: '/missions' })
  const navigate = useNavigate({ from: '/missions' })
  const missionId = search.missionId ?? search.taskId

  function selectMission(nextId: string | null) {
    void navigate({
      search: (prev) => {
        if (!nextId) {
          const { missionId: _m, taskId: _t, ...rest } = prev
          return rest
        }
        return { ...prev, missionId: nextId, taskId: undefined }
      },
      replace: true,
    })
  }

  return (
    <MissionsLayout
      selectedMissionId={missionId ?? null}
      onSelectMission={selectMission}
    />
  )
}
