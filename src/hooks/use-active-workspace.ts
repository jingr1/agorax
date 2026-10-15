import { useQuery } from '@tanstack/react-query'
import {
  fetchActiveWorkspace,
  type ActiveWorkspace,
} from '@/lib/workspace-client'
import { useProfiles } from '@/screens/chat/hooks/use-profiles'

export type { ActiveWorkspace }

/** Shared active workspace path for file browsers / search invalidation. */
export function useActiveWorkspace() {
  const { workspaceProfileName } = useProfiles()
  return useQuery({
    queryKey: ['workspace', 'active', workspaceProfileName],
    queryFn: () => fetchActiveWorkspace(workspaceProfileName),
    staleTime: 15_000,
    retry: false,
  })
}
