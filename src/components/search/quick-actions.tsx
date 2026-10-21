import { cn } from '@/lib/utils'

type QuickAction = {
  id: string
  label: string
  description: string
  emoji: string
  onSelect: () => void
}

type QuickActionsProps = {
  recentSearches: Array<string>
  actions: Array<QuickAction>
  selectedIndex?: number
  onSelectRecent: (value: string) => void
  onSelectAction?: (action: QuickAction) => void
}

export function QuickActions({
  recentSearches,
  actions,
  selectedIndex = -1,
  onSelectRecent,
  onSelectAction,
}: QuickActionsProps) {
  const recentCount = recentSearches.length
  const total = recentCount + actions.length

  function isRecentSelected(index: number) {
    return selectedIndex === index
  }

  function isActionSelected(index: number) {
    return selectedIndex === recentCount + index
  }

  return (
    <div className="space-y-4">
      {recentSearches.length > 0 ? (
        <div>
          <div className="mb-2 text-xs font-medium text-muted-foreground">
            Recent Searches
          </div>
          <div className="flex flex-wrap gap-2">
            {recentSearches.map((entry, index) => (
              <button
                key={entry}
                type="button"
                onClick={() => onSelectRecent(entry)}
                className={cn(
                  'rounded-md border border-border bg-muted/60 px-2.5 py-1 text-xs text-foreground transition-colors',
                  'hover:bg-muted',
                  'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-500',
                  isRecentSelected(index) &&
                    'border-accent-500/40 bg-accent-500/20 text-accent-400',
                )}
              >
                {entry}
              </button>
            ))}
          </div>
        </div>
      ) : null}

      <div>
        <div className="mb-2 text-xs font-medium text-muted-foreground">
          Quick Actions
        </div>
        <div className="grid grid-cols-2 gap-2 md:grid-cols-4">
          {actions.map((action, index) => (
            <button
              key={action.id}
              type="button"
              onClick={() => onSelectAction?.(action)}
              className={cn(
                'flex min-h-20 flex-col items-start rounded-lg border border-border bg-card/80 p-3 text-left transition-colors backdrop-blur-sm',
                'hover:border-accent-500/35 hover:bg-accent-500/15',
                'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-500',
                isActionSelected(index) &&
                  'border-accent-500/35 bg-accent-500/15',
              )}
            >
              <span className="text-base leading-none">{action.emoji}</span>
              <span className="mt-2 text-sm font-medium text-foreground text-balance">
                {action.label}
              </span>
              <span className="mt-1 line-clamp-2 text-xs text-muted-foreground text-pretty">
                {action.description}
              </span>
            </button>
          ))}
        </div>
      </div>
    </div>
  )
}

export type { QuickAction }
