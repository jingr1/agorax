import { useQuery } from '@tanstack/react-query'
import type { EnhancedFeature } from '@/lib/feature-gates'

interface GatewayStatus {
  capabilities: Record<string, boolean>
  claudeUrl: string
}

export function useFeatureAvailable(feature: EnhancedFeature): boolean {
  const { data, isFetched } = useQuery({
    queryKey: ['gateway-status'],
    queryFn: async () => {
      const res = await fetch('/api/gateway-status')
      if (!res.ok) return null
      return (await res.json()) as GatewayStatus
    },
    staleTime: 300_000,
    refetchInterval: 300_000,
  })

  // Optimistic: assume feature is available while still loading.
  // Only block rendering after we've confirmed it's unavailable.
  if (!isFetched) return true
  return data?.capabilities?.[feature] === true
}
