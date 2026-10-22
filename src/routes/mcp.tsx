import { createFileRoute } from '@tanstack/react-router'
import { usePageTitle } from '@/hooks/use-page-title'
import { McpScreen } from '@/screens/mcp/mcp-screen'

export const Route = createFileRoute('/mcp')({
  ssr: false,
  component: McpRoute,
})

function McpRoute() {
  usePageTitle('MCP Servers')
  // Platform MCP library + profile/config fallback are local control-plane.
  // Do not gate the page on Hermes native `/api/mcp` capability.
  return <McpScreen />
}
