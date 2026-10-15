export type JobDeliveryTarget = {
  id: string
  label: string
  platform?: string
  kind: 'preset' | 'platform'
  requiresGateway?: boolean
}

export async function fetchJobDeliveryTargets(): Promise<
  Array<JobDeliveryTarget>
> {
  const response = await fetch('/api/job-delivery-targets')
  if (!response.ok) {
    throw new Error(`Failed to fetch delivery targets (${response.status})`)
  }
  const data = (await response.json()) as { targets?: Array<JobDeliveryTarget> }
  return Array.isArray(data.targets) ? data.targets : []
}
