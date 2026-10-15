import { createServer } from 'node:http'
import { readFile, stat } from 'node:fs/promises'
import { existsSync, readFileSync } from 'node:fs'
import { join, extname } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = fileURLToPath(new URL('.', import.meta.url))
const ENV_PATH = join(__dirname, '.env')

/** Parse KEY=VALUE lines; only fills keys not already in process.env. */
function loadDotEnvFile(filePath) {
  const dotenv = readFileSync(filePath, 'utf-8')
  for (const line of dotenv.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('#')) continue
    const eq = trimmed.indexOf('=')
    if (eq < 0) continue
    const key = trimmed.slice(0, eq)
    const val = trimmed.slice(eq + 1)
    if (!(key in process.env)) process.env[key] = val
  }
}

// Production `node server-entry.js` has no Vite loadEnv(). Require a project .env
// (same as dev after `cp .env.example .env`) — do not fall back to ~/.hermes/.
if (!existsSync(ENV_PATH)) {
  console.error(
    '\n[workspace] refusing to start.\n' +
      '  Production mode requires .env in the project root.\n' +
      '  Vite dev loads this file automatically; `pnpm start` does not read ~/.hermes/.env.\n' +
      '\n' +
      '  Create it from the template:\n' +
      '    cp .env.example .env\n' +
      '\n' +
      '  When Hermes Agent uses API_SERVER_KEY, set the same value as HERMES_API_TOKEN\n' +
      '  in .env (see .env.example). Shell exports still override .env values.\n',
  )
  process.exit(1)
}
loadDotEnvFile(ENV_PATH)

const { default: server } = await import('./dist/server/server.js')
const CLIENT_DIR = join(__dirname, 'dist', 'client')

// Content Security Policy — emitted as an HTTP response header on EVERY
// response so the policy survives any edge body transformations (e.g.
// Cloudflare's JS Challenge inserting a `<meta http-equiv="Content-Security-Policy">`
// with a per-request nonce into the served HTML when a request trips the
// "impersonate browsers" rule).
//
// KEEP IN SYNC with `src/lib/csp.ts` (single source of truth) and
// `src/routes/__root.tsx` APP_CSP (which emits the same policy as `<meta>`).
// If you change the directives here, change them in all three places.
const APP_CSP_HEADERS = [
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
].join('; ')

const ALWAYS_HEADERS = {
  'Content-Security-Policy': APP_CSP_HEADERS,
  'Permissions-Policy': 'microphone=(self), camera=()',
  // Tighten later if/when CSP moves to nonce-based — the dash prefix
  // makes adding/removing trivial without searching the codebase.
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'strict-origin-when-cross-origin',
}

const port = parseInt(process.env.PORT || '6734', 10)
// Default HOST to localhost-only. Operators who want the workspace reachable
// on a LAN / Tailscale / public surface must opt in explicitly with
// HOST=0.0.0.0 *and* set CLAUDE_PASSWORD (enforced below). See #122.
const host = process.env.HOST || '127.0.0.1'

function isNonLoopbackHost(h) {
  if (!h) return false
  const norm = h.trim().toLowerCase()
  if (norm === '127.0.0.1' || norm === '::1' || norm === 'localhost') {
    return false
  }
  return true
}

if (isNonLoopbackHost(host)) {
  // Honor HERMES_PASSWORD (current name) with CLAUDE_PASSWORD as a back-compat
  // fallback for deployments configured pre-rename.
  const password = (
    process.env.HERMES_PASSWORD ||
    process.env.CLAUDE_PASSWORD ||
    ''
  ).trim()
  if (!password) {
    console.error(
      '\n[workspace] refusing to start.\n' +
        `  HOST is set to "${host}" (non-loopback), but HERMES_PASSWORD is unset.\n` +
        '  This would expose a high-privilege control plane (terminals, files, agents)\n' +
        '  to anyone who can reach the port. Either:\n' +
        '    • set HOST=127.0.0.1 for local-only access, or\n' +
        '    • set HERMES_PASSWORD=<strong-secret> to enable workspace auth, or\n' +
        '    • set HERMES_ALLOW_INSECURE_REMOTE=1 to bypass this check (not recommended).\n' +
        '  See #122 for context.\n',
    )
    const allowInsecure = (
      process.env.HERMES_ALLOW_INSECURE_REMOTE ||
      process.env.CLAUDE_ALLOW_INSECURE_REMOTE ||
      ''
    )
      .trim()
      .toLowerCase()
    if (
      allowInsecure !== '1' &&
      allowInsecure !== 'true' &&
      allowInsecure !== 'yes'
    ) {
      process.exit(1)
    }
    console.warn(
      '[workspace] HERMES_ALLOW_INSECURE_REMOTE is set — starting anyway.',
    )
  }

  // Warn when serving over plain HTTP with a password: NODE_ENV=production
  // sets the Secure flag on session cookies, which browsers silently drop
  // over http://.  Operators must set COOKIE_SECURE=0 for plain-HTTP LAN
  // deployments.  See #149.
  const cookieSecureOverride = (process.env.COOKIE_SECURE || '')
    .trim()
    .toLowerCase()
  const cookieSecureExplicit =
    cookieSecureOverride === '0' ||
    cookieSecureOverride === 'false' ||
    cookieSecureOverride === 'no'
  if (!cookieSecureExplicit && process.env.NODE_ENV === 'production') {
    console.warn(
      '\n[workspace] warning: plain-HTTP LAN deployment detected.\n' +
        '  NODE_ENV=production enables the Secure flag on session cookies.\n' +
        '  Browsers silently drop Secure cookies over http://, so login will fail.\n' +
        '  Add COOKIE_SECURE=0 to your .env to fix this.  See #149.\n',
    )
  }
}

const MIME_TYPES = {
  '.js': 'application/javascript',
  '.mjs': 'application/javascript',
  '.css': 'text/css',
  '.html': 'text/html',
  '.json': 'application/json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.eot': 'application/vnd.ms-fontobject',
  '.map': 'application/json',
  '.txt': 'text/plain',
  '.xml': 'application/xml',
  '.webmanifest': 'application/manifest+json',
}

async function tryServeStatic(req, res) {
  const url = new URL(
    req.url || '/',
    `http://${req.headers.host || 'localhost'}`,
  )
  const pathname = decodeURIComponent(url.pathname)

  // Prevent directory traversal
  if (pathname.includes('..')) return false

  // Asset requests should never fall through to the SSR handler. If a browser
  // asks for a stale hashed JS/CSS chunk after a deploy or branch switch,
  // returning the HTML shell with 200 text/html makes the SPA fail as a black
  // screen. Return a real 404 instead so clients reload/recover correctly and
  // health checks can detect the broken asset reference.
  if (pathname.startsWith('/assets/')) {
    const filePath = join(CLIENT_DIR, pathname)
    if (!filePath.startsWith(CLIENT_DIR)) return false
    try {
      const fileStat = await stat(filePath)
      if (!fileStat.isFile()) throw new Error('not a file')
    } catch {
      res.writeHead(404, {
        'Content-Type': 'text/plain; charset=utf-8',
        'Cache-Control':
          'no-store, no-cache, must-revalidate, proxy-revalidate',
      })
      res.end('Asset not found')
      return true
    }
  }

  const filePath = join(CLIENT_DIR, pathname)

  // Make sure the resolved path is within CLIENT_DIR
  if (!filePath.startsWith(CLIENT_DIR)) return false

  try {
    const fileStat = await stat(filePath)
    if (!fileStat.isFile()) return false

    const ext = extname(filePath).toLowerCase()
    const contentType = MIME_TYPES[ext] || 'application/octet-stream'
    const data = await readFile(filePath)

    const headers = {
      'Content-Type': contentType,
      'Content-Length': data.length,
    }

    // Cache hashed assets aggressively (they have content hashes in filenames)
    if (pathname.startsWith('/assets/')) {
      headers['Cache-Control'] = 'public, max-age=31536000, immutable'
    }

    res.writeHead(200, headers)
    res.end(data)
    return true
  } catch {
    return false
  }
}

async function requestHandler(req, res) {
  // Try static files first (client assets)
  if (req.method === 'GET' || req.method === 'HEAD') {
    const served = await tryServeStatic(req, res)
    if (served) return
  }

  // Fall through to SSR handler
  const url = new URL(
    req.url || '/',
    `http://${req.headers.host || 'localhost'}`,
  )

  const headers = new Headers()
  for (const [key, value] of Object.entries(req.headers)) {
    if (value) headers.set(key, Array.isArray(value) ? value.join(', ') : value)
  }

  let body = null
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    body = await new Promise((resolve) => {
      const chunks = []
      req.on('data', (chunk) => chunks.push(chunk))
      req.on('end', () => resolve(Buffer.concat(chunks)))
    })
  }

  const request = new Request(url.toString(), {
    method: req.method,
    headers,
    body,
    duplex: 'half',
  })

  try {
    const response = await server.fetch(request)

    // Merge ALWAYS_HEADERS on top of the SSR-emitted headers. These MUST
    // win — sending them here means the policy is observable even if the
    // body got replaced by an edge-side JS Challenge or WAF response page.
    const headers = Object.fromEntries(response.headers.entries())
    for (const [name, value] of Object.entries(ALWAYS_HEADERS)) {
      if (typeof value === 'string') headers[name] = value
    }

    // /api/* responses must NEVER be cacheable by intermediaries — the SPA
    // uses /api/auth-check, /api/connection-status, etc. to decide whether
    // to show the password form. Cloudflare's Browser Cache TTL default
    // (7200s) is applied to any GET that doesn't say `no-store`, which
    // caused the auth-check response to be served stale from the edge
    // for ~2h after a fresh login, trapping the user in a password loop.
    // Strip any Cache-Control/Pragma/Expires on API responses so the
    // edge never reuses them. Hash-named assets keep their immutable
    // header (set above in tryServeStatic) and are unaffected here
    // because static assets short-circuit before this branch.
    const reqPathname = new URL(request.url).pathname
    if (reqPathname.startsWith('/api/')) {
      headers['Cache-Control'] = 'no-store, no-cache, must-revalidate, private'
      headers['Pragma'] = 'no-cache'
      headers['Expires'] = '0'
    }

    res.writeHead(response.status, headers)

    if (response.body) {
      const reader = response.body.getReader()
      const pump = async () => {
        while (true) {
          const { done, value } = await reader.read()
          if (done) break
          res.write(value)
        }
        res.end()
      }
      pump().catch((err) => {
        console.error('Stream error:', err)
        res.end()
      })
    } else {
      const text = await response.text()
      res.end(text)
    }
  } catch (err) {
    console.error('Request error:', err)
    res.writeHead(500)
    res.end('Internal Server Error')
  }
}

function listenOn(bindHost) {
  const httpServer = createServer(requestHandler)
  // Node's default keepAliveTimeout is 5s. Chrome keeps idle HTTP/1.1 sockets
  // much longer and does not retry a POST that lands on one the server already
  // closed, so /api/send-stream fails with "Failed to fetch" and never reaches
  // the route. Stay above the browser pool; headersTimeout must be larger.
  httpServer.keepAliveTimeout = 65_000
  httpServer.headersTimeout = 70_000
  httpServer.listen(port, bindHost, () => {
    console.log(`Agorax running at http://${bindHost}:${port}`)
  })
  return httpServer
}

listenOn(host)

// The Bot Mode group-chat runner is started automatically when the server
// module loads (see src/routes/api/connection-status.ts). It is idempotent,
// so this keeps production and dev behavior identical without relying on a
// separate bundled entry point that may be tree-shaken away.

// Cloudflared remote-managed ingress currently points at http://localhost:10280.
// On macOS, localhost may resolve to ::1 before 127.0.0.1; if Workspace only
// listens on IPv4 loopback, tunneled requests intermittently fail with
// `dial tcp [::1]:10280: connect: connection refused`. Keep the default
// local-only security posture while also serving IPv6 loopback.
if (host === '127.0.0.1') {
  listenOn('::1')
}
