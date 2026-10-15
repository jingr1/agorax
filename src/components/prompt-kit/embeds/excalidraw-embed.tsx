import { useEffect, useMemo, useState, type ComponentType } from 'react'
import { CodeBlock } from '../code-block'
import { cn } from '@/lib/utils'

type ExcalidrawScene = {
  type?: string
  version?: number
  source?: string
  elements?: Array<Record<string, unknown>>
  appState?: Record<string, unknown>
  files?: Record<string, unknown>
}

export function parseExcalidrawScene(raw: string): ExcalidrawScene | null {
  try {
    const parsed = JSON.parse(raw) as unknown
    if (!parsed || typeof parsed !== 'object') return null
    const scene = parsed as ExcalidrawScene
    if (!Array.isArray(scene.elements)) return null
    return scene
  } catch {
    return null
  }
}

function SceneFallback({
  code,
  className,
  label,
}: {
  code: string
  className?: string
  label?: string
}) {
  return (
    <div className={cn('my-2 flex flex-col gap-1', className)}>
      {label ? (
        <div className="text-[11px] text-primary-600">{label}</div>
      ) : null}
      <CodeBlock content={code} language="json" className="my-0" />
    </div>
  )
}

function ExcalidrawCanvas({
  scene,
  className,
  title,
}: {
  scene: ExcalidrawScene
  className?: string
  title?: string
}) {
  const [loaded, setLoaded] = useState<{
    Comp: ComponentType<{
      initialData?: unknown
      viewModeEnabled?: boolean
      zenModeEnabled?: boolean
      UIOptions?: unknown
    }>
  } | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)

  const initialData = useMemo(
    () => ({
      elements: scene.elements ?? [],
      appState: {
        viewBackgroundColor:
          (scene.appState?.viewBackgroundColor as string | undefined) ??
          '#ffffff',
        ...(scene.appState ?? {}),
        collaborators: undefined,
      },
      files: scene.files ?? {},
      scrollToContent: true,
    }),
    [scene],
  )

  useEffect(() => {
    let cancelled = false
    void (async () => {
      try {
        await import('@excalidraw/excalidraw/index.css')
        const mod = await import('@excalidraw/excalidraw')
        if (!cancelled) {
          setLoaded({
            Comp: mod.Excalidraw as ComponentType<{
              initialData?: unknown
              viewModeEnabled?: boolean
              zenModeEnabled?: boolean
              UIOptions?: unknown
            }>,
          })
        }
      } catch (err) {
        if (!cancelled) {
          setLoadError(
            err instanceof Error ? err.message : 'Failed to load Excalidraw',
          )
        }
      }
    })()
    return () => {
      cancelled = true
    }
  }, [])

  if (loadError) {
    return (
      <div
        className={cn(
          'my-2 rounded-lg border border-primary-200 px-3 py-2 text-sm text-primary-800',
          className,
        )}
      >
        {loadError}
      </div>
    )
  }

  const Excalidraw = loaded?.Comp

  return (
    <div
      className={cn(
        'my-2 overflow-hidden rounded-lg border border-primary-200 bg-white',
        className,
      )}
    >
      {title ? (
        <div className="flex items-center justify-between gap-2 border-b border-primary-200 bg-primary-50/50 px-3 py-1.5 text-[11px] text-primary-700">
          <span className="truncate font-medium">{title}</span>
          <span className="shrink-0 opacity-70">Excalidraw · view only</span>
        </div>
      ) : null}
      <div className="h-[min(52vh,420px)] min-h-[240px] w-full">
        {Excalidraw ? (
          <Excalidraw
            initialData={initialData}
            viewModeEnabled
            zenModeEnabled
            UIOptions={{
              canvasActions: {
                changeViewBackgroundColor: false,
                clearCanvas: false,
                export: false,
                loadScene: false,
                saveToActiveFile: false,
                toggleTheme: false,
                saveAsImage: true,
              },
            }}
          />
        ) : (
          <div className="flex h-full items-center justify-center text-xs text-primary-600">
            Loading diagram…
          </div>
        )}
      </div>
    </div>
  )
}

type ExcalidrawEmbedProps = {
  code: string
  className?: string
  title?: string
}

/** Render a fenced ```excalidraw JSON scene. */
export function ExcalidrawEmbed({
  code,
  className,
  title = 'Excalidraw',
}: ExcalidrawEmbedProps) {
  const scene = useMemo(() => parseExcalidrawScene(code), [code])
  if (!scene) {
    return (
      <SceneFallback
        code={code}
        className={className}
        label="Invalid Excalidraw JSON"
      />
    )
  }
  return <ExcalidrawCanvas scene={scene} className={className} title={title} />
}

type ExcalidrawFromUrlProps = {
  src: string
  title?: string
  className?: string
}

/** Fetch MEDIA `/api/media?path=…` (or remote URL) and render the scene. */
export function ExcalidrawFromUrl({
  src,
  title,
  className,
}: ExcalidrawFromUrlProps) {
  const [code, setCode] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    setCode(null)
    setError(null)

    void (async () => {
      try {
        const res = await fetch(src, { credentials: 'same-origin' })
        if (!res.ok) {
          throw new Error(`Failed to load diagram (${res.status})`)
        }
        const text = await res.text()
        if (!cancelled) setCode(text)
      } catch (err) {
        if (!cancelled) {
          setError(
            err instanceof Error ? err.message : 'Failed to load diagram',
          )
        }
      }
    })()

    return () => {
      cancelled = true
    }
  }, [src])

  if (error) {
    return (
      <div
        className={cn(
          'my-2 rounded-lg border border-primary-200 bg-primary-50/40 px-3 py-2 text-sm text-primary-800',
          className,
        )}
      >
        <div className="font-medium">{title ?? 'Excalidraw'}</div>
        <div className="mt-1 text-xs text-primary-600">{error}</div>
        <a
          href={src}
          className="mt-2 inline-block text-xs text-accent-600 underline"
          target="_blank"
          rel="noreferrer"
        >
          Open file
        </a>
      </div>
    )
  }

  if (!code) {
    return (
      <div
        className={cn(
          'my-2 rounded-lg border border-primary-200 px-3 py-6 text-center text-xs text-primary-600',
          className,
        )}
      >
        Loading Excalidraw…
      </div>
    )
  }

  return (
    <ExcalidrawEmbed
      code={code}
      className={className}
      title={title ?? 'Excalidraw'}
    />
  )
}
