/** Lightweight chat route placeholder — must stay in a tiny module (no chat-screen import). */
export function ChatRouteLoading() {
  return (
    <div className="flex h-full min-h-[12rem] flex-col bg-[var(--theme-bg)]">
      <div className="flex flex-1 flex-col gap-4 px-4 py-6 sm:px-6">
        <div className="flex gap-3 animate-pulse">
          <div className="size-6 shrink-0 rounded-full bg-primary-200" />
          <div className="flex-1 space-y-2 pt-0.5">
            <div className="h-4 w-3/4 rounded bg-primary-200" />
            <div className="h-4 w-1/2 rounded bg-primary-200" />
          </div>
        </div>
        <div className="flex gap-3 animate-pulse">
          <div className="size-6 shrink-0 rounded-full bg-primary-200" />
          <div className="flex-1 space-y-2 pt-0.5">
            <div className="h-4 w-2/3 rounded bg-primary-200" />
            <div className="h-4 w-5/6 rounded bg-primary-200" />
            <div className="h-4 w-1/3 rounded bg-primary-200" />
          </div>
        </div>
      </div>
    </div>
  )
}
