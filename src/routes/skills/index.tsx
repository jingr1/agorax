import { createFileRoute } from '@tanstack/react-router'
import { usePageTitle } from '@/hooks/use-page-title'
import { PlatformSkillsScreen } from '@/screens/skills/platform-skills-screen'

export const Route = createFileRoute('/skills/')({
  ssr: false,
  component: SkillsIndexRoute,
})

function SkillsIndexRoute() {
  usePageTitle('Skills')
  return <PlatformSkillsScreen />
}
