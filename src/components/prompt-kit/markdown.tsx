import {
  Suspense,
  createContext,
  lazy,
  memo,
  useContext,
  useId,
  useMemo,
  useRef,
} from 'react'
import type { ComponentProps } from 'react'
import ReactMarkdown from 'react-markdown'
import rehypeKatex from 'rehype-katex'
import rehypeRaw from 'rehype-raw'
import rehypeSanitize from 'rehype-sanitize'
import remarkBreaks from 'remark-breaks'
import remarkGfm from 'remark-gfm'
import remarkMath from 'remark-math'
import { CodeBlock } from './code-block'
import { extractLanguageFromClassName } from './code-block/utils'
import type { Components } from 'react-markdown'
import { normalizeMathDelimiters } from '@/lib/markdown-math'
import {
  hashMarkdownBlockContent,
  splitStreamingMarkdownBlocks,
  stabilizeStreamingMarkdownTail,
  useStreamingVisibleText,
  STREAMING_MARKDOWN_FRAME_MS,
  STREAMING_MARKDOWN_MAX_CHARS_PER_SECOND,
  STREAMING_MARKDOWN_TAIL_FLUSH_CHARS,
} from '@/lib/streaming-markdown'
import { cn } from '@/lib/utils'
import 'katex/dist/katex.min.css'

// Excalidraw / Mermaid are multi‑MB optional embeds — keep them off the
// markdown sync graph so chat message paint does not pay for diagram runtimes.
const ExcalidrawEmbed = lazy(() =>
  import('./embeds/excalidraw-embed').then((m) => ({
    default: m.ExcalidrawEmbed,
  })),
)
const ExcalidrawFromUrl = lazy(() =>
  import('./embeds/excalidraw-embed').then((m) => ({
    default: m.ExcalidrawFromUrl,
  })),
)
const MermaidEmbed = lazy(() =>
  import('./embeds/mermaid-embed').then((m) => ({ default: m.MermaidEmbed })),
)

/**
 * Rewrite Workspace-local `MEDIA:<path>` tokens emitted by Hermes Agent to the
 * authenticated media endpoint. Messaging bridges intercept MEDIA tags before
 * rendering; the web chat sees raw markdown/HTML and needs this client-side
 * rewrite so browsers can load the file through Workspace instead of trying to
 * resolve a local filesystem path directly.
 *
 * Also expands bare `MEDIA:…` tokens (not already inside markdown/HTML) into
 * images, audio/video players, or download links — matching WebUI's common case.
 */
export function rewriteLocalMediaSources(content: string): string {
  const rewritePath = (rawPath: string): string | null => {
    let path = rawPath.trim()
    if (!path) return null
    if (/^file:\/\//i.test(path)) {
      try {
        path = decodeURIComponent(new URL(path).pathname || path)
      } catch {
        path = path.replace(/^file:\/\//i, '')
      }
    }
    if (/^https?:\/\//i.test(path)) {
      // Keep remote URLs as-is (callers may still wrap them as media).
      return path
    }
    return `/api/media?path=${encodeURIComponent(path)}`
  }

  const basename = (path: string) => {
    const cleaned = path.split('?')[0] || path
    const parts = cleaned.split(/[/\\]/)
    return parts[parts.length - 1] || cleaned
  }

  const markdownImage = /(!\[[^\]]*\]\()MEDIA:([^\)\s]+)(\))/g
  const withMarkdownImages = content.replace(
    markdownImage,
    (_match, prefix: string, mediaPath: string, suffix: string) => {
      const rewritten = rewritePath(mediaPath)
      return rewritten
        ? `${prefix}${rewritten}${suffix}`
        : `${prefix}MEDIA:${mediaPath}${suffix}`
    },
  )

  const htmlImage = /(<img\b[^>]*\bsrc=)(["'])MEDIA:([^"']+)\2/gi
  const withHtmlImages = withMarkdownImages.replace(
    htmlImage,
    (_match, prefix: string, quote: string, mediaPath: string) => {
      const rewritten = rewritePath(mediaPath)
      return rewritten
        ? `${prefix}${quote}${rewritten}${quote}`
        : `${prefix}${quote}MEDIA:${mediaPath}${quote}`
    },
  )

  // Bare MEDIA:path tokens → concrete media markup.
  return withHtmlImages.replace(
    /(?<![[(\/"'=])MEDIA:([^\s\)\]]+)/g,
    (_match, mediaPath: string) => {
      const rewritten = rewritePath(mediaPath)
      if (!rewritten) return `MEDIA:${mediaPath}`
      const name = basename(mediaPath)
      const lower = name.toLowerCase()
      if (/\.(png|jpe?g|gif|webp|bmp|svg)$/i.test(lower)) {
        return `![${name}](${rewritten})`
      }
      if (/\.(mp4|webm|mov|m4v)$/i.test(lower)) {
        return `<video controls preload="metadata" src="${rewritten}" style="max-width:100%;border-radius:8px"></video>`
      }
      if (/\.(mp3|wav|ogg|m4a|aac|flac)$/i.test(lower)) {
        return `<audio controls preload="metadata" src="${rewritten}" style="width:100%"></audio>`
      }
      if (/\.excalidraw$/i.test(lower)) {
        // Custom host node → ExcalidrawFromUrl via markdown `div` component.
        return `<div class="hermes-excalidraw" data-src="${rewritten}" data-title="${name}"></div>`
      }
      return `[📎 ${name}](${rewritten})`
    },
  )
}

export type MarkdownProps = {
  children: string
  id?: string
  className?: string
  components?: Partial<Components>
  /**
   * Tutti-aligned live path: char-rate reveal + tail stabilize + blank-line
   * blocks with memoized settled segments (only the open tail re-parses).
   */
  streaming?: boolean
}

type TableRenderContextValue = {
  headersRef: React.MutableRefObject<Array<string>>
  columnIndexRef: React.MutableRefObject<number>
  collectingHeaderRef: React.MutableRefObject<boolean>
}

const TableRenderContext = createContext<TableRenderContextValue | null>(null)

function useTableRenderContext() {
  return useContext(TableRenderContext)
}

function textFromNode(node: React.ReactNode): string {
  if (typeof node === 'string' || typeof node === 'number') {
    return String(node)
  }
  if (Array.isArray(node)) {
    return node.map((item: React.ReactNode) => textFromNode(item)).join('')
  }
  if (node && typeof node === 'object' && 'props' in node) {
    const element = node as { props: { children?: React.ReactNode } }
    return textFromNode(element.props.children)
  }
  return ''
}

function slugifyHeading(children: React.ReactNode): string {
  const raw = textFromNode(children)
    .trim()
    .toLowerCase()
    .replace(/[^\w\s-]/g, '')
    .replace(/\s+/g, '-')
  return raw.length > 0 ? raw : 'section'
}

function extractFencedCodeContent(children: React.ReactNode): string {
  return String(children ?? '').replace(/\n$/, '')
}

function isFencedCodeBlock(className: string, content: string): boolean {
  if (extractLanguageFromClassName(className) !== 'text') return true
  return content.includes('\n')
}

function normalizeFenceLanguage(language: string): string {
  const lower = language.trim().toLowerCase()
  if (lower === 'mmd') return 'mermaid'
  return lower
}

const INITIAL_COMPONENTS: Partial<Components> = {
  code: function CodeComponent({ className, children, ...props }) {
    const content = extractFencedCodeContent(children)
    const fenceLanguage = normalizeFenceLanguage(
      extractLanguageFromClassName(className),
    )

    if (isFencedCodeBlock(className ?? '', content)) {
      if (fenceLanguage === 'mermaid') {
        return (
          <Suspense fallback={null}>
            <MermaidEmbed code={content} className="w-full my-2" />
          </Suspense>
        )
      }
      if (fenceLanguage === 'excalidraw') {
        return (
          <Suspense fallback={null}>
            <ExcalidrawEmbed code={content} className="w-full my-2" />
          </Suspense>
        )
      }
      return (
        <CodeBlock
          content={content}
          language={fenceLanguage}
          className="w-full my-2"
        />
      )
    }

    return (
      <code
        className={cn(
          'inline-code rounded-[4px] px-[5px] py-px text-[0.9em]',
          className,
        )}
        {...props}
      >
        {children}
      </code>
    )
  },
  pre: function PreComponent({ children }) {
    // Fenced blocks are rendered by `code`; avoid an extra <pre> wrapper.
    return <>{children}</>
  },
  div: function DivComponent({ className, children, ...props }) {
    const classes = Array.isArray(className)
      ? className.filter(Boolean).join(' ')
      : String(className ?? '')
    const src =
      (props as { 'data-src'?: string; dataSrc?: string })['data-src'] ??
      (props as { dataSrc?: string }).dataSrc
    const title =
      (props as { 'data-title'?: string; dataTitle?: string })['data-title'] ??
      (props as { dataTitle?: string }).dataTitle

    if (
      classes.includes('hermes-excalidraw') &&
      typeof src === 'string' &&
      src
    ) {
      return (
        <Suspense fallback={null}>
          <ExcalidrawFromUrl
            src={src}
            title={typeof title === 'string' ? title : undefined}
            className="w-full my-2"
          />
        </Suspense>
      )
    }

    return (
      <div className={className} {...props}>
        {children}
      </div>
    )
  },
  h1: function H1Component({ children }) {
    return (
      <h1 className="mt-5 mb-2 text-2xl leading-tight font-bold text-[var(--md-strong)] text-balance first:mt-0">
        {children}
      </h1>
    )
  },
  h2: function H2Component({ children }) {
    const id = slugifyHeading(children)
    return (
      <h2
        id={id}
        className="mt-5 mb-2 text-xl leading-tight font-bold text-[var(--md-strong)] text-balance first:mt-0"
      >
        <a
          href={`#${id}`}
          className="group/heading inline-flex items-center gap-1 no-underline"
        >
          <span>{children}</span>
          <span
            aria-hidden="true"
            className="text-primary-500 opacity-0 transition-opacity group-hover/heading:opacity-100"
          >
            #
          </span>
        </a>
      </h2>
    )
  },
  h3: function H3Component({ children }) {
    const id = slugifyHeading(children)
    return (
      <h3
        id={id}
        className="mt-4 mb-1.5 text-lg leading-tight font-bold text-[var(--md-strong)] text-balance first:mt-0"
      >
        <a
          href={`#${id}`}
          className="group/heading inline-flex items-center gap-1 no-underline"
        >
          <span>{children}</span>
          <span
            aria-hidden="true"
            className="text-primary-500 opacity-0 transition-opacity group-hover/heading:opacity-100"
          >
            #
          </span>
        </a>
      </h3>
    )
  },
  h4: function H4Component({ children }) {
    return (
      <h4 className="mt-4 mb-1.5 text-base leading-tight font-bold text-[var(--md-strong)] text-balance first:mt-0">
        {children}
      </h4>
    )
  },
  h5: function H5Component({ children }) {
    return (
      <h5 className="mt-3.5 mb-1 text-sm leading-tight font-bold text-[var(--md-strong)] text-balance first:mt-0">
        {children}
      </h5>
    )
  },
  h6: function H6Component({ children }) {
    return (
      <h6 className="mt-3.5 mb-1 text-sm leading-tight font-semibold text-[var(--md-em)] text-balance first:mt-0">
        {children}
      </h6>
    )
  },
  p: function PComponent({ children }) {
    return (
      <p className="text-primary-950 text-pretty leading-relaxed">{children}</p>
    )
  },
  ul: function UlComponent({ children }) {
    return (
      <ul className="ml-4 list-disc text-primary-950 marker:text-primary-400">
        {children}
      </ul>
    )
  },
  ol: function OlComponent({ children }) {
    return (
      <ol className="ml-4 list-decimal text-primary-950 marker:text-primary-500">
        {children}
      </ol>
    )
  },
  li: function LiComponent({ children }) {
    return <li className="leading-relaxed">{children}</li>
  },
  a: function AComponent({ children, href }) {
    if (!href) {
      return <span className="text-primary-950">{children}</span>
    }
    return (
      <a
        href={href}
        className="text-[var(--md-link)] underline decoration-[color-mix(in_srgb,var(--md-link)_40%,transparent)] underline-offset-4 transition-colors hover:decoration-[var(--md-link)]"
        target="_blank"
        rel="noopener noreferrer"
      >
        {children}
      </a>
    )
  },
  img: function ImgComponent({ src, alt, ...props }) {
    if (!src) {
      return null
    }
    return <img src={src} alt={alt ?? ''} {...props} />
  },
  blockquote: function BlockquoteComponent({ children }) {
    return (
      <blockquote className="border-l-2 border-primary-300 pl-4 text-primary-900 italic">
        {children}
      </blockquote>
    )
  },
  strong: function StrongComponent({ children }) {
    return (
      <strong className="font-semibold text-[var(--md-strong)]">
        {children}
      </strong>
    )
  },
  b: function BComponent({ children }) {
    return <b className="font-semibold text-[var(--md-strong)]">{children}</b>
  },
  em: function EmComponent({ children }) {
    return <em className="italic text-[var(--md-em)]">{children}</em>
  },
  hr: function HrComponent() {
    return <hr className="my-3 border-primary-200" />
  },
  table: function TableComponent({ children }) {
    const headersRef = useRef<Array<string>>([])
    const columnIndexRef = useRef(0)
    const collectingHeaderRef = useRef(false)
    return (
      <TableRenderContext.Provider
        value={{ headersRef, columnIndexRef, collectingHeaderRef }}
      >
        <div className="my-3 max-w-full overflow-x-auto rounded-lg border border-primary-200 bg-primary-50/20">
          <table className="w-full min-w-max border-collapse text-sm sm:min-w-full tabular-nums">
            {children}
          </table>
        </div>
      </TableRenderContext.Provider>
    )
  },
  thead: function TheadComponent({ children }) {
    const context = useTableRenderContext()
    if (context) {
      context.collectingHeaderRef.current = true
      context.columnIndexRef.current = 0
      context.headersRef.current = []
    }
    return (
      <thead className="sticky top-0 z-10 border-b border-primary-200 bg-primary-100/95 backdrop-blur-sm max-sm:hidden">
        {children}
      </thead>
    )
  },
  tbody: function TbodyComponent({ children }) {
    const context = useTableRenderContext()
    if (context) {
      context.collectingHeaderRef.current = false
      context.columnIndexRef.current = 0
    }
    return (
      <tbody className="divide-y divide-primary-100 max-sm:block max-sm:divide-y-0">
        {children}
      </tbody>
    )
  },
  tr: function TrComponent({ children }) {
    const context = useTableRenderContext()
    if (context) {
      context.columnIndexRef.current = 0
    }
    return (
      <tr className="odd:bg-primary-50/60 even:bg-primary-100/20 transition-colors hover:bg-primary-100/45 max-sm:mb-3 max-sm:block max-sm:overflow-hidden max-sm:rounded-lg max-sm:border max-sm:border-primary-200 max-sm:bg-primary-50">
        {children}
      </tr>
    )
  },
  th: function ThComponent({ children }) {
    const context = useTableRenderContext()
    if (context) {
      const index = context.columnIndexRef.current
      context.columnIndexRef.current += 1
      if (context.collectingHeaderRef.current) {
        context.headersRef.current[index] = textFromNode(children).trim()
      }
    }
    return (
      <th className="px-3 py-2 text-left font-medium text-primary-950 whitespace-nowrap">
        {children}
      </th>
    )
  },
  td: function TdComponent({ children }) {
    const context = useTableRenderContext()
    let label = ''
    if (context) {
      const index = context.columnIndexRef.current
      context.columnIndexRef.current += 1
      label = context.headersRef.current[index] ?? `Column ${index + 1}`
    }
    return (
      <td
        data-label={label}
        className="px-3 py-2 text-primary-950 align-top max-sm:grid max-sm:grid-cols-[minmax(0,9rem)_1fr] max-sm:gap-3 max-sm:border-b max-sm:border-primary-100 max-sm:px-3 max-sm:py-2 max-sm:last:border-b-0 max-sm:before:content-[attr(data-label)] max-sm:before:text-xs max-sm:before:font-medium max-sm:before:text-primary-700"
      >
        {children}
      </td>
    )
  },
  tfoot: function TfootComponent({ children }) {
    return (
      <tfoot className="border-t border-primary-200 bg-primary-100/40">
        {children}
      </tfoot>
    )
  },
}

const HTML_SANITIZE_SCHEMA = {
  tagNames: [
    'a',
    'abbr',
    'article',
    'b',
    'bdi',
    'blockquote',
    'br',
    'caption',
    'center',
    'cite',
    'code',
    'col',
    'colgroup',
    'data',
    'dd',
    'del',
    'details',
    'dfn',
    'div',
    'dl',
    'dt',
    'em',
    'figcaption',
    'figure',
    'footer',
    'h1',
    'h2',
    'h3',
    'h4',
    'h5',
    'h6',
    'header',
    'hgroup',
    'hr',
    'i',
    'img',
    'ins',
    'kbd',
    'li',
    'main',
    'mark',
    'nav',
    'ol',
    'p',
    'pre',
    'q',
    'rp',
    'rt',
    'ruby',
    's',
    'samp',
    'section',
    'small',
    'span',
    'strong',
    'sub',
    'summary',
    'sup',
    'table',
    'tbody',
    'td',
    'tfoot',
    'th',
    'thead',
    'time',
    'tr',
    'u',
    'ul',
    'var',
    'video',
    'wbr',
  ],
  attributes: {
    '*': ['className', 'class', 'title', 'lang', 'dir'],
    a: ['href', 'target', 'rel', 'download'],
    img: ['src', 'alt', 'width', 'height', 'loading'],
    audio: ['src', 'controls', 'preload', 'style'],
    video: ['src', 'controls', 'preload', 'style'],
    div: ['dataSrc', 'dataTitle', 'style'],
    td: ['colspan', 'rowspan', 'headers'],
    th: ['colspan', 'rowspan', 'headers', 'scope'],
    col: ['span'],
    colgroup: ['span'],
    ol: ['start', 'type'],
    li: ['value'],
    details: ['open'],
    time: ['datetime'],
    data: ['value'],
    del: ['datetime'],
    ins: ['datetime'],
  },
  protocols: {
    a: { href: ['http', 'https', 'mailto', 'tel', 'relative'] },
    img: { src: ['http', 'https', 'data', 'relative'] },
    audio: { src: ['http', 'https', 'relative'] },
    video: { src: ['http', 'https', 'relative'] },
  },
}

const REMARK_PLUGINS = [
  remarkGfm,
  [remarkMath, { singleDollarTextMath: true }],
  remarkBreaks,
] as NonNullable<ComponentProps<typeof ReactMarkdown>['remarkPlugins']>

// Sanitize first so KaTeX HTML (style + MathML) is not stripped by the schema.
// Matches webui: markdown/HTML is cleaned, then katex.render runs last with
// throwOnError:false, trust:false, strict:'ignore'.
const REHYPE_PLUGINS = [
  rehypeRaw,
  [rehypeSanitize, HTML_SANITIZE_SCHEMA],
  [
    rehypeKatex,
    {
      throwOnError: false,
      trust: false,
      strict: 'ignore',
    },
  ],
] as NonNullable<ComponentProps<typeof ReactMarkdown>['rehypePlugins']>

const MemoizedMarkdownBlock = memo(
  function MarkdownBlock({
    content,
    components = INITIAL_COMPONENTS,
  }: {
    content: string
    components?: Partial<Components>
  }) {
    return (
      <ReactMarkdown
        remarkPlugins={REMARK_PLUGINS}
        rehypePlugins={REHYPE_PLUGINS}
        components={components}
      >
        {content}
      </ReactMarkdown>
    )
  },
  function propsAreEqual(prevProps, nextProps) {
    return prevProps.content === nextProps.content
  },
)

MemoizedMarkdownBlock.displayName = 'MemoizedMarkdownBlock'

function MarkdownComponent({
  children,
  id,
  className,
  components = INITIAL_COMPONENTS,
  streaming = false,
}: MarkdownProps) {
  const generatedId = useId()
  const blockId = id ?? generatedId

  const preparedSource = useMemo(
    () => normalizeMathDelimiters(rewriteLocalMediaSources(children)),
    [children],
  )

  const visibleSource = useStreamingVisibleText(preparedSource, {
    enabled: streaming,
    frameMs: STREAMING_MARKDOWN_FRAME_MS,
    maxCharsPerSecond: STREAMING_MARKDOWN_MAX_CHARS_PER_SECOND,
    trailingFlushChars: STREAMING_MARKDOWN_TAIL_FLUSH_CHARS,
  })

  const stabilizedSource = useMemo(
    () =>
      stabilizeStreamingMarkdownTail(visibleSource, { streaming }).content,
    [streaming, visibleSource],
  )

  // Always split the stabilized visible source. Switching stabilized →
  // prepared on settle remounted blocks whenever the tail stabilizer had
  // closed a fence / stripped a partial token (transcript jump).
  const sourceForBlocks = stabilizedSource
  const blocks = useMemo(() => {
    const parts = splitStreamingMarkdownBlocks(sourceForBlocks)
    return parts.map((block, index) => ({
      key: `${blockId}-${index}:${hashMarkdownBlockContent(block.initialKeyContent)}`,
      content: block.content,
    }))
  }, [blockId, sourceForBlocks])

  return (
    <div
      className={cn(
        'flex flex-col gap-2 break-words overflow-hidden',
        className,
      )}
      data-streaming-markdown={streaming ? 'true' : undefined}
    >
      {blocks.map((block) => (
        <MemoizedMarkdownBlock
          key={block.key}
          content={block.content}
          components={components}
        />
      ))}
    </div>
  )
}

const Markdown = memo(MarkdownComponent)
Markdown.displayName = 'Markdown'

export { Markdown }
