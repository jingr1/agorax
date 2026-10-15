import { createFileRoute } from '@tanstack/react-router'
import BackendUnavailableState from '@/components/backend-unavailable-state'
import { usePageTitle } from '@/hooks/use-page-title'
import { getUnavailableReason } from '@/lib/feature-gates'
import { useFeatureAvailable } from '@/hooks/use-feature-available'
import { PlatformSkillsScreen } from '@/screens/skills/platform-skills-screen'

export const Route = createFileRoute('/skills/')({
  ssr: false,
  component: SkillsIndexRoute,
})

function SkillsIndexRoute() {
  usePageTitle('Skills')
  if (!useFeatureAvailable('skills')) {
    return (
      <BackendUnavailableState
        feature="Skills"
        description={getUnavailableReason('Skills')}
      />
    )
  }
  return <PlatformSkillsScreen />
}
