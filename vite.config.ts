import { URL, fileURLToPath } from 'node:url'
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from 'node:fs'
import { resolve, join } from 'node:path'
import * as yaml from 'yaml'

// devtools removed
import { tanstackStart } from '@tanstack/react-start/plugin/vite'
import viteReact from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
// nitro plugin removed (tanstackStart handles server runtime)
import { defineConfig, loadEnv } from 'vite'
import viteTsConfigPaths from 'vite-tsconfig-paths'

const config = defineConfig(({ mode, command }) => {
  const env = loadEnv(mode, process.cwd(), '')
  // Bridge loadEnv into process.env for server-side SSR runtime code that
  // reads env vars directly from process.env (e.g. getBearerToken() in
  // openai-compat-api.ts reads process.env.HERMES_API_TOKEN). Without this,
  // Vite's loadEnv only populates the local `env` object — not process.env.
  for (const key of Object.keys(env)) {
    if (!(key in process.env)) {
      process.env[key] = env[key]
    }
  }
  const hermesApiUrl = env.HERMES_API_URL?.trim() || 'http://127.0.0.1:8642'
  // /api/connection-status is handled by the real route file at
  // src/routes/api/connection-status.ts; the dev server no longer
  // intercepts that path with a slim shortcut. See #285.

  // Hermes Agent auto-start state
  let claudeAgentStarted = false

  const startClaudeAgent = async () => {
    if (claudeAgentStarted) return
    const explicitUrl = (
      env.HERMES_API_URL ||
      process.env.HERMES_API_URL ||
      hermesApiUrl ||
      ''
    ).trim()
    let remote = false
    try {
      const host = new URL(
        explicitUrl || 'http://127.0.0.1:8642',
      ).hostname.toLowerCase()
      remote =
        Boolean(explicitUrl) &&
        host !== '127.0.0.1' &&
        host !== 'localhost' &&
        host !== '::1'
    } catch {
      remote = false
    }
    if (remote) {
      console.log(
        `[hermes-agent] Skipping auto-start — using external API: ${explicitUrl}`,
      )
      claudeAgentStarted = true
      return
    }

    try {
      const { ensureActiveProfileGateway } =
        await import('./src/server/gateway-pool')
      const result = await ensureActiveProfileGateway()
      claudeAgentStarted = true
      if (result.ok) {
        console.log(
          `[hermes-agent] ✓ ${result.profile ?? 'default'} ${result.message}${
            'url' in result && result.url ? ` on ${result.url}` : ''
          }`,
        )
      } else {
        console.warn(
          `[hermes-agent] ${'error' in result ? result.error : 'failed to start'}`,
        )
      }
    } catch (error) {
      console.warn(
        `[hermes-agent] Auto-start failed: ${
          error instanceof Error ? error.message : String(error)
        }`,
      )
    }
  }

  // Allow access from Tailscale, LAN, or custom domains via env var
  // e.g. CLAUDE_ALLOWED_HOSTS=my-server.tail1234.ts.net,192.168.1.50
  const _allowedHosts: string[] | true = env.CLAUDE_ALLOWED_HOSTS?.trim()
    ? env
        .CLAUDE_ALLOWED_HOSTS!.split(',')
        .map((h) => h.trim())
        .filter(Boolean)
    : ['.ts.net'] // allow all Tailscale hostnames by default
  let proxyTarget = 'http://127.0.0.1:8642'

  try {
    const parsed = new URL(hermesApiUrl)
    parsed.protocol = parsed.protocol === 'wss:' ? 'https:' : 'http:'
    parsed.pathname = ''
    proxyTarget = parsed.toString().replace(/\/$/, '')
  } catch {
    // fallback
  }

  return {
    test: {
      environment: 'jsdom',
      exclude: [
        '**/node_modules/**',
        '**/dist/**',
        '**/skills-bundle/**',
        '**/.{idea,git,cache,output,temp}/**',
        // Workspace packages run under `node --test --experimental-strip-types`
        // (their suites import node:test, which vitest cannot host).
        'packages/**',
        // Playwright specs, not vitest suites.
        'e2e/**',
      ],
      // Force vitest to run React through its own transform pipeline so ESM
      // `import` and CJS `require('react')` share a single module instance.
      // Without this, react-dom sets the dispatcher on its CJS React copy while
      // components call hooks on the ESM React copy → null dispatcher → crash.
      server: {
        deps: {
          inline: [
            'react',
            'react-dom',
            '@testing-library/react',
            '@testing-library/dom',
            'zustand',
            'use-sync-external-store',
          ],
        },
      },
    },
    define: {
      // Note: Do NOT set 'process.env': {} here — TanStack Start uses environment-based
      // builds where isSsrBuild is unreliable. Blanket process.env replacement breaks
      // server-side code in Docker (kills runtime env var access).
      // Client-side process.env is handled per-environment below.
    },
    build: {
      // Mermaid / Excalidraw lazy chunks legitimately exceed 500 kB; keep the
      // warning for unexpected growth above that band.
      chunkSizeWarningLimit: 900,
      rollupOptions: {
        output: {
          // Conservative vendor splits only. Broad @tanstack/zod grouping
          // trips Rollup `getVariableForExportName` under TanStack Start's
          // dual client/SSR graph — keep those on the natural graph.
          manualChunks(id) {
            if (!id.includes('node_modules')) return
            const pnpmMatch = id.match(
              /\/node_modules\/\.pnpm\/[^/]+\/node_modules\/(@[^/]+\/[^/]+|[^/]+)\//,
            )
            const normalMatch = id.match(
              /\/node_modules\/(@[^/]+\/[^/]+|[^/]+)\//,
            )
            const pkg = pnpmMatch?.[1] ?? normalMatch?.[1]
            if (!pkg) return

            if (
              pkg === 'react' ||
              pkg === 'react-dom' ||
              pkg === 'scheduler'
            ) {
              return 'vendor-react'
            }
            if (
              pkg === 'motion' ||
              pkg === 'framer-motion' ||
              pkg === 'motion-dom' ||
              pkg === 'motion-utils'
            ) {
              return 'vendor-motion'
            }
            if (pkg === 'katex' || pkg === 'rehype-katex') {
              return 'vendor-katex'
            }
            if (pkg === 'prismjs') {
              return 'vendor-prism'
            }
          },
        },
      },
    },
    resolve: {
      alias: {
        '@': fileURLToPath(new URL('./src', import.meta.url)),
        '@agorax/agent-activity-core': fileURLToPath(
          new URL('./packages/agent-activity-core/src/index.ts', import.meta.url),
        ),
        '@agorax/agent-activity-daemon-adapter': fileURLToPath(
          new URL('./packages/agent-activity-daemon-adapter/src/index.ts', import.meta.url),
        ),
      },
      // Single React instance for ESM + CJS interop (vitest inline comment applies here too).
      // Without dedupe, react-dom may bind the dispatcher on a different copy than hooks use
      // → "Cannot read properties of null (reading 'useContext')".
      dedupe: ['react', 'react-dom'],
    },
    ssr: {
      external: [
        'playwright',
        'playwright-core',
        'playwright-extra',
        'puppeteer-extra-plugin-stealth',
      ],
    },
    optimizeDeps: {
      holdUntilCrawlEnd: true,
      // Pre-bundle xterm so the client never requests a missing `.vite/deps/xterm.js`.
      // Excluding xterm left metadata pointing at deps/ without generating the file → black terminals.
      include: [
        'react',
        'react-dom',
        'react/jsx-runtime',
        'react/jsx-dev-runtime',
        'zustand',
        '@tanstack/react-router',
        '@tanstack/react-query',
        'motion/react',
        'xterm',
        'xterm-addon-fit',
        'xterm-addon-web-links',
        'prismjs',
      ],
      exclude: [
        'playwright',
        'playwright-core',
        'playwright-extra',
        'puppeteer-extra-plugin-stealth',
      ],
      needsInterop: ['xterm', 'xterm-addon-fit', 'xterm-addon-web-links'],
    },
    server: {
      warmup: {
        clientFiles: [
          './src/routes/__root.tsx',
          './src/components/workspace-shell.tsx',
          './src/screens/chat/chat-screen.tsx',
        ],
      },
      // Force IPv4 — 'localhost' resolves to ::1 (IPv6) on Windows, breaking connectivity
      host: '0.0.0.0',
      // Port precedence:
      //   1. --port CLI flag (wins, but we no longer hardcode it in package.json)
      //   2. $PORT env var (for containers, reverse proxies, WhatsApp bridge collisions, etc. — see #96)
      //   3. default 6734 (matches README/docs/docker-compose expectations)
      port: process.env.PORT ? Number(process.env.PORT) : 6734,
      // Managed Workspace launchers expect a stable port. Fail loudly instead
      // of silently hopping to 3001+ so launchctl/service health matches the
      // actual listening socket.
      strictPort: true,
      allowedHosts: true,
      watch: {
        ignored: [
          // NOTE: the generated TanStack route tree must NOT be added to this
          // ignore list — doing so causes route changes to require a full
          // dev-server restart. See src/router-route-resolution.test.ts.
          // Real fix for HMR thrash on the generated tree is to ensure only
          // ONE vite dev server runs against this source tree at a time.
          // Local portable session store, rewritten on every chat send.
          // Without this, the watcher fires on every message → spurious
          // server-side reload events / test churn during development.
          '**/.runtime/**',
          // Embedded managed-agent SQLite state is also rewritten on every
          // message and is not part of the module graph.
          '**/.agorax/**',
          // Internal TanStack Start state cache.
          '**/.tanstack/**',
          // Local plan/notes/scratch state used by OMC tooling — never
          // imported by the module graph, but file events still spam logs.
          '**/.omc/**',
          '**/.omx/**',
          // Agent registry writes are runtime state, not module changes.
          // Ignore them so Settings CRUD does not trigger a full dev reload.
          '**/agents.yaml',
          // Build artifacts.
          '**/dist/**',
          '**/.output/**',
          // Test/coverage outputs.
          '**/coverage/**',
          '**/playwright-report/**',
          '**/test-results/**',
          // Editor / agent metadata.
          '**/.vscode/**',
          '**/.claude/**',
          '**/.cursor/**',
          // Loose log files.
          '**/*.log',
          // Runtime config written by the swarm PATCH API — not imported by
          // the module graph; writing it must not trigger a Vite HMR reload.
          '**/swarm.yaml',
        ],
      },
      proxy: {
        // Dev proxy for Hermes backend (settings / model catalog paths).
        '/api/hermes-proxy': {
          target: proxyTarget,
          changeOrigin: true,
          rewrite: (path) => path.replace(/^\/api\/hermes-proxy/, ''),
        },
      },
    },
    plugins: [
      // devtools(),
      // this is the plugin that enables path aliases
      viteTsConfigPaths({
        projects: ['./tsconfig.json'],
      }),
      tailwindcss(),
      // Disable TanStack Start's route-file transform in Vitest so that
      // createFileRoute() calls keep their inline server handlers for tests.
      ...(process.env.VITEST ? [] : [tanstackStart()]),
      viteReact(),
      {
        name: 'hermes-dev-no-cache',
        apply: 'serve',
        configureServer(server) {
          server.middlewares.use((_req, res, next) => {
            res.setHeader(
              'Cache-Control',
              'no-store, no-cache, must-revalidate, max-age=0',
            )
            res.setHeader('Pragma', 'no-cache')
            res.setHeader('Expires', '0')
            next()
          })
        },
      },
      {
        name: 'agorax-dev-server',
        configureServer(server) {
          // Content Security Policy as a real HTTP response header. Sending
          // it here (not as a `<meta>` tag) keeps the policy authoritative
          // when an edge proxy mutates the response body — e.g. Cloudflare's
          // JS Challenge injecting a per-request nonce into the served HTML
          // when a browser request trips the "impersonate browsers" WAF rule.
          // Without this, the inline-style source expression
          // `style-src ' 'nonce-...'; self` gets concatenated onto our meta
          // tag and chromium rejects every script and stylesheet with a
          // mangled-CSP error. See the parallel logic in server-entry.js
          // for production.
          server.middlewares.use((_req, res, next) => {
            // KEEP IN SYNC with src/lib/csp.ts and server-entry.js
            res.setHeader(
              'Content-Security-Policy',
              [
                "default-src 'self'",
                "base-uri 'self'",
                "object-src 'none'",
                "form-action 'self'",
                "script-src 'self' 'unsafe-inline' 'wasm-unsafe-eval' https://cdn.jsdelivr.net",
                "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com https://cdn.jsdelivr.net",
                "img-src 'self' data: blob: https:",
                "font-src 'self' data: https://fonts.gstatic.com",
                "connect-src 'self' ws: wss: http: https:",
                "worker-src 'self' blob:",
                "media-src 'self' blob: data:",
                "frame-src 'self' http: https:",
              ].join('; '),
            )
            res.setHeader('X-Content-Type-Options', 'nosniff')
            res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin')
            res.setHeader('Permissions-Policy', 'microphone=(self), camera=()')
            next()
          })
          server.middlewares.use((req, res, next) => {
            const requestPath = req.url?.split('?')[0]
            if (req.method === 'GET' && requestPath === '/api/healthcheck') {
              res.statusCode = 200
              res.setHeader('content-type', 'application/json')
              res.end(JSON.stringify({ ok: true }))
              return
            }

            // /api/connection-status is handled by the real route file at
            // src/routes/api/connection-status.ts — it returns the full
            // ConnectionStatus payload including capabilities and chatMode
            // that downstream feature gates depend on. Earlier versions
            // had an inline shortcut handler here that returned a slim
            // body ({ok, mode, backend}) which silently broke things like
            // useFeatureCapability/useFeatureAvailable in dev mode. See #285.
            next()
          })

          // PATCH /api/swarm-roster — writes directly to swarm.yaml.
          // Bypasses TanStack Start SSR (which hangs on PATCH in dev mode).
          server.middlewares.use(async (req, res, next) => {
            const path = req.url?.split('?')[0] ?? ''
            if (req.method !== 'PATCH' || path !== '/api/swarm-roster') {
              next()
              return
            }
            const chunks: Buffer[] = []
            for await (const chunk of req as AsyncIterable<Buffer>)
              chunks.push(chunk)
            let body: { workerId?: string; patch?: Record<string, unknown> }
            try {
              body = JSON.parse(Buffer.concat(chunks).toString())
            } catch {
              res.statusCode = 400
              res.setHeader('content-type', 'application/json')
              res.end(JSON.stringify({ ok: false, error: 'Invalid JSON' }))
              return
            }
            const workerId =
              typeof body.workerId === 'string' ? body.workerId.trim() : ''
            if (!workerId) {
              res.statusCode = 400
              res.setHeader('content-type', 'application/json')
              res.end(JSON.stringify({ ok: false, error: 'workerId required' }))
              return
            }
            const patch =
              body.patch &&
              typeof body.patch === 'object' &&
              !Array.isArray(body.patch)
                ? body.patch
                : {}
            if (Object.keys(patch).length === 0) {
              res.statusCode = 400
              res.setHeader('content-type', 'application/json')
              res.end(
                JSON.stringify({ ok: false, error: 'patch object required' }),
              )
              return
            }
            try {
              const SWARM_ROSTER_PATH = resolve(process.cwd(), 'swarm.yaml')
              if (!existsSync(SWARM_ROSTER_PATH))
                throw new Error(`swarm.yaml not found at ${SWARM_ROSTER_PATH}`)
              const raw = readFileSync(SWARM_ROSTER_PATH, 'utf8')
              const roster = yaml.parse(raw) as {
                version?: number
                workers?: Array<Record<string, unknown>>
              }
              const workers = roster.workers ?? []
              const idx = workers.findIndex(
                (w) =>
                  (w.id as string)?.toLowerCase() === workerId.toLowerCase(),
              )
              if (idx < 0)
                throw new Error(`Worker ${workerId} not found in swarm roster`)
              workers[idx] = { ...workers[idx], ...patch }

              writeFileSync(
                SWARM_ROSTER_PATH,
                yaml.stringify({ ...roster, workers }),
                'utf8',
              )
              res.statusCode = 200
              res.setHeader('content-type', 'application/json')
              res.end(
                JSON.stringify({
                  ok: true,
                  path: SWARM_ROSTER_PATH,
                  savedAt: Date.now(),
                }),
              )
            } catch (err) {
              res.statusCode = 400
              res.setHeader('content-type', 'application/json')
              res.end(
                JSON.stringify({
                  ok: false,
                  error:
                    err instanceof Error
                      ? err.message
                      : 'Failed to patch swarm roster',
                }),
              )
            }
          })

          // dev-only: disable Node's default 5-minute request timeout so
          // long-running SSE streams (agent runs that go silent for minutes
          // during heavy reasoning / tool calls) don't get killed mid-stream
          // by the HTTP layer. Heartbeats handle keep-alive at the application
          // layer. Production servers should keep their default timeouts to
          // avoid slowloris exposure.
          if (command === 'serve' && server.httpServer) {
            const httpServer = server.httpServer as unknown as {
              requestTimeout?: number
              headersTimeout?: number
              timeout?: number
            }
            // Do NOT set requestTimeout=0 globally — it makes SSR PATCH requests
            // hang forever when the TanStack Start handler fails to respond.
            // Instead, keep the default 5-minute timeout as a safety net.
            httpServer.requestTimeout = 0
            httpServer.headersTimeout = 0
            httpServer.timeout = 0
          }

          // dev-only: disable Node's default 5-minute request timeout so
          // This is the correct layering: httpServer-level = infinite (SSE safety),
          // per-route = selective enforcement (PATCH/POST/API routes get a deadline).
          server.middlewares.use(async (req, res, next) => {
            const { socket } = req
            if (!socket) {
              next()
              return
            }
            const method = req.method?.toUpperCase() ?? 'GET'
            const path = req.url?.split('?')[0] ?? ''
            // SSE and long-running swarm routes need no socket timeout.
            // Agent chat streams (`/api/agents/:id/chat`) often sit silent
            // until the first model token; a 15s idle kill shows as
            // "network error" in the Claude Code shell (Sonnet TTFT can
            // exceed that).
            const isLongRunning =
              path.startsWith('/api/sse') ||
              path.startsWith('/sse') ||
              path.startsWith('/api/live') ||
              path === '/api/terminal-stream' ||
              path === '/api/terminal-input' ||
              path === '/api/terminal-resize' ||
              path === '/api/swarm-direct-chat' ||
              path === '/api/swarm-dispatch' ||
              path === '/api/swarm-decompose' ||
              // Managed npm / Hermes git upgrades can run for minutes with no
              // response bytes; the default 15s idle socket kill aborts the
              // browser mutation while the daemon/handler keeps working.
              path === '/api/agent-runtime/install' ||
              /^\/api\/agents\/[^/]+\/chat$/.test(path)
            const timeout = isLongRunning ? 0 : 15_000
            socket.setTimeout(timeout)
            next()
          })

          // Auto-start hermes-agent when dev server launches.
          // Skip when launchd manages the gateway (AGORAX_AUTO_START_AGENT=false)
          // to avoid SIGTERM cycle on close that nukes the launchd-managed process.
          const autoStartAgent =
            process.env.AGORAX_AUTO_START_AGENT !== 'false'
          if (command === 'serve' && autoStartAgent) {
            void startClaudeAgent()
          }

          // The group-chat runner is started by the server module import in
          // src/routes/api/connection-status.ts, so no extra startup is needed here.
        },
      },
      // Client-only: replace process.env references in client bundles.
      // Server bundles must keep real process.env for Docker runtime env vars.
      // Exclusion rule: server-side code & tests are not browser bundles —
      // they need runtime process.env access (e.g. Docker secrets, CI env).
      //
      // Vitest runs modules under environment.name === 'client' (jsdom), so
      // without the VITEST / mode===test guard this plugin turns
      // `process.env.FOO` into `{}.FOO` in route helpers like swarm-dispatch —
      // tests that mutate process.env then silently read undefined.
      {
        name: 'client-process-env',
        enforce: 'pre',
        transform(code, id) {
          if (mode === 'test' || process.env.VITEST) return null
          const envName = this.environment?.name
          if (envName !== 'client') return null
          // Skip server/runtime, API routes (often import shared helpers that
          // read process.env at runtime), and test files.
          if (
            id.includes('/src/server/') ||
            id.includes('/src/routes/api/') ||
            id.includes('.test.')
          )
            return null
          if (
            !code.includes('process.env') &&
            !code.includes('process.platform')
          )
            return null

          // Replace specific env vars first, then the generic fallback
          let result = code
          result = result.replace(
            /process\.env\.HERMES_API_URL/g,
            JSON.stringify(hermesApiUrl),
          )
          result = result.replace(
            /process\.env\.CLAUDE_API_TOKEN/g,
            JSON.stringify(env.CLAUDE_API_TOKEN || ''),
          )
          result = result.replace(
            /process\.env\.NODE_ENV/g,
            JSON.stringify(mode),
          )
          result = result.replace(/process\.env/g, '{}')
          result = result.replace(/process\.platform/g, '"browser"')
          if (result === code) return null
          // Empty map: string replaces are tiny; returning a bare string makes
          // Vite warn that sourcemaps are likely incorrect.
          return { code: result, map: { mappings: '' } }
        },
      },
      // Copy pty-helper.py into the server assets directory after build
      {
        name: 'copy-pty-helper',
        closeBundle() {
          const src = resolve('src/server/pty-helper.py')
          const destDir = resolve('dist/server/assets')
          const dest = resolve(destDir, 'pty-helper.py')
          if (existsSync(src)) {
            mkdirSync(destDir, { recursive: true })
            copyFileSync(src, dest)
          }
        },
      },
    ],
  }
})

export default config
