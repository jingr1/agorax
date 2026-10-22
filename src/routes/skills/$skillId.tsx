import { createFileRoute, useParams } from '@tanstack/react-router'
import { usePageTitle } from '@/hooks/use-page-title'
import { PlatformSkillDetailScreen } from '@/screens/skills/platform-skill-detail-screen'

export const Route = createFileRoute('/skills/$skillId')({
  ssr: false,
  component: SkillDetailRoute,
})

function SkillDetailRoute() {
  const { skillId } = useParams({ from: '/skills/$skillId' })
  usePageTitle('Skill detail')
  // Detail/edit/bind use `/api/platform-skills` — available without gateway
  // skills capability (Hermes + managed agents).
  return <PlatformSkillDetailScreen skillId={skillId} />
}
