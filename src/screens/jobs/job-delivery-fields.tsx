'use client'

import { useMemo } from 'react'
import { useQuery } from '@tanstack/react-query'
import {
  fetchJobDeliveryTargets,
  type JobDeliveryTarget,
} from '@/lib/job-delivery-targets'

type JobDeliveryFieldsProps = {
  deliver: Array<string>
  onDeliverChange: (deliver: Array<string>) => void
}

function groupTargets(targets: Array<JobDeliveryTarget>) {
  const presets = targets.filter((target) => target.kind === 'preset')
  const platforms = targets.filter((target) => target.kind === 'platform')
  return { presets, platforms }
}

function DeliveryChip({
  target,
  active,
  onToggle,
}: {
  target: JobDeliveryTarget
  active: boolean
  onToggle: () => void
}) {
  return (
    <button
      type="button"
      onClick={onToggle}
      title={
        target.requiresGateway
          ? `Requires Hermes gateway with ${target.platform ?? target.id} configured`
          : undefined
      }
      className="rounded-full border px-3 py-1.5 text-xs font-medium transition-colors"
      style={{
        background: active ? 'var(--theme-accent)' : 'var(--theme-card)',
        borderColor: active ? 'var(--theme-accent)' : 'var(--theme-border)',
        color: active
          ? '#fff'
          : target.requiresGateway
            ? 'var(--theme-muted)'
            : 'var(--theme-text)',
      }}
    >
      {target.label}
      {target.requiresGateway ? ' ⚡' : ''}
    </button>
  )
}

export function JobDeliveryFields({
  deliver,
  onDeliverChange,
}: JobDeliveryFieldsProps) {
  const targetsQuery = useQuery({
    queryKey: ['jobs', 'delivery-targets'],
    queryFn: fetchJobDeliveryTargets,
    staleTime: 60_000,
  })

  const { presets, platforms } = useMemo(
    () => groupTargets(targetsQuery.data ?? []),
    [targetsQuery.data],
  )

  const unknownTargets = useMemo(
    () =>
      deliver.filter(
        (target) =>
          !(targetsQuery.data ?? []).some((entry) => entry.id === target),
      ),
    [deliver, targetsQuery.data],
  )

  function toggleTarget(targetId: string) {
    onDeliverChange(
      deliver.includes(targetId)
        ? deliver.filter((entry) => entry !== targetId)
        : [...deliver, targetId],
    )
  }

  return (
    <div className="space-y-3">
      <div>
        <label className="text-sm font-medium">Deliver to</label>
        <p className="mt-1 text-xs" style={{ color: 'var(--theme-muted)' }}>
          Hermes-wide delivery targets. Profile only controls where the job is
          stored, not where output can be sent.
        </p>
      </div>

      {targetsQuery.isLoading ? (
        <p className="text-xs" style={{ color: 'var(--theme-muted)' }}>
          Loading delivery targets...
        </p>
      ) : null}

      {presets.length > 0 ? (
        <div className="flex flex-wrap gap-2">
          {presets.map((target) => (
            <DeliveryChip
              key={target.id}
              target={target}
              active={deliver.includes(target.id)}
              onToggle={() => toggleTarget(target.id)}
            />
          ))}
        </div>
      ) : null}

      {platforms.length > 0 ? (
        <div className="space-y-2">
          <p
            className="text-xs font-medium"
            style={{ color: 'var(--theme-muted)' }}
          >
            Platforms
          </p>
          <div className="flex flex-wrap gap-2">
            {platforms.map((target) => (
              <DeliveryChip
                key={target.id}
                target={target}
                active={deliver.includes(target.id)}
                onToggle={() => toggleTarget(target.id)}
              />
            ))}
          </div>
        </div>
      ) : null}

      {unknownTargets.length > 0 ? (
        <div className="space-y-2">
          <p
            className="text-xs font-medium"
            style={{ color: 'var(--theme-muted)' }}
          >
            Current custom targets
          </p>
          <div className="flex flex-wrap gap-2">
            {unknownTargets.map((target) => (
              <DeliveryChip
                key={target}
                target={{
                  id: target,
                  label: target,
                  kind: 'platform',
                  requiresGateway: true,
                }}
                active={deliver.includes(target)}
                onToggle={() => toggleTarget(target)}
              />
            ))}
          </div>
        </div>
      ) : null}

      {targetsQuery.isError ? (
        <p className="text-xs" style={{ color: 'var(--theme-warning)' }}>
          Failed to load platform channels. Preset targets are still available
          after refresh.
        </p>
      ) : null}
    </div>
  )
}
