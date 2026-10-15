import { createFileRoute, useParams } from '@tanstack/react-router'
import BackendUnavailableState from '@/components/backend-unavailable-state'
import { usePageTitle } from '@/hooks/use-page-title'
import { getUnavailableReason } from '@/lib/feature-gates'
import { useFeatureAvailable } from '@/hooks/use-feature-available'
import { PlatformSkillDetailScreen } from '@/screens/skills/platform-skill-detail-screen'

export const Route = createFileRoute('/skills/$skillId')({
  ssr: false,
  component: SkillDetailRoute,
})

function SkillDetailRoute() {
  const { skillId } = useParams({ from: '/skills/$skillId' })
  usePageTitle('Skill detail')
  if (!useFeatureAvailable('skills')) {
    return (
      <BackendUnavailableState
        feature="Skills"
        description={getUnavailableReason('Skills')}
      />
    )
  }
  return <PlatformSkillDetailScreen skillId={skillId} />
}
