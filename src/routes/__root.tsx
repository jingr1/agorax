import {
  HeadContent,
  Outlet,
  Scripts,
  createRootRoute,
} from '@tanstack/react-router'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { Suspense, lazy, useEffect, useState } from 'react'
import appCss from '../styles.css?url'
import { getRootSurfaceState } from './-root-layout-state'
import { fetchClaudeAuthStatus } from '@/lib/claude-auth'
import type { AuthStatus } from '@/lib/claude-auth'
import { UsageMeter } from '@/components/usage-meter'
import { TerminalShortcutListener } from '@/components/terminal-shortcut-listener'
import { GlobalShortcutListener } from '@/components/global-shortcut-listener'
import { WorkspaceShell } from '@/components/workspace-shell'
import { Toaster } from '@/components/ui/toast'
import { AttentionToaster } from '@/components/attention-toaster'
import { UpdateCenterNotifier } from '@/components/update-center-notifier'
import {
  applyInterfacePreferences,
  initializeSettingsAppearance,
  useSettings,
} from '@/hooks/use-settings'
import { useApplyChatWidth } from '@/hooks/use-chat-settings'
import {
  ONBOARDING_COMPLETE_EVENT,
  ONBOARDING_KEY,
  readOnboardingComplete,
  writeOnboardingComplete,
} from '@/components/onboarding/onboarding-storage'
import { ErrorBoundary } from '@/components/error-boundary'

// Heavy first-visit / optional chrome — keep out of the eager entry chunk.
const LoginScreen = lazy(() =>
  import('@/components/auth/login-screen').then((m) => ({
    default: m.LoginScreen,
  })),
)
const AgoraxOnboarding = lazy(() =>
  import('@/components/onboarding/agorax-onboarding').then((m) => ({
    default: m.AgoraxOnboarding,
  })),
)
const SearchModal = lazy(() =>
  import('@/components/search/search-modal').then((m) => ({
    default: m.SearchModal,
  })),
)
const KeyboardShortcutsModal = lazy(() =>
  import('@/components/keyboard-shortcuts-modal').then((m) => ({
    default: m.KeyboardShortcutsModal,
  })),
)
const MobilePromptTrigger = lazy(() =>
  import('@/components/mobile-prompt/MobilePromptTrigger').then((m) => ({
    default: m.MobilePromptTrigger,
  })),
)
const OnboardingTour = lazy(() =>
  import('@/components/onboarding/onboarding-tour').then((m) => ({
    default: m.OnboardingTour,
  })),
)

// Content Security Policy used to be emitted here as a `<meta http-equiv>`
// tag. That made the workspace unusable when the Cloudflare JS Challenge
// tripped on a request and rewrote the served HTML with its own per-request
// `<meta name="Content-Security-Policy">` containing a nonce, producing a
// concatenated malformed policy that chromium rejected (e.g.
// `style-src ' 'nonce-…'; self`). The policy now lives in src/lib/csp.ts
// and is emitted as a real HTTP response header by server-entry.js
// (production) and vite.config.ts (dev/preview). Leave it that way.

const THEME_STORAGE_KEY = 'claude-theme'
const DEFAULT_THEME = 'default'
const VALID_THEMES = [
  'default',
  'default-light',
  'claude-nous',
  'claude-nous-light',
  'claude-official',
  'claude-official-light',
  'claude-classic',
  'claude-classic-light',
  'claude-slate',
  'claude-slate-light',
  'matrix',
  'matrix-light',
  'scifi',
  'scifi-light',
]

const themeScript = `
(() => {
  window.process = window.process || { env: {}, platform: 'browser' };

  try {
    const root = document.documentElement
    const storedRaw = localStorage.getItem('${THEME_STORAGE_KEY}')
    const legacy = { webui: 'default', 'webui-light': 'default-light' }
    const storedTheme = legacy[storedRaw] || storedRaw
    if (storedRaw && legacy[storedRaw]) {
      localStorage.setItem('${THEME_STORAGE_KEY}', storedTheme)
    }
    const theme = ${JSON.stringify(VALID_THEMES)}.includes(storedTheme) ? storedTheme : '${DEFAULT_THEME}'
    const lightThemes = ['default-light', 'claude-nous-light', 'claude-official-light', 'claude-classic-light', 'claude-slate-light', 'matrix-light', 'scifi-light']
    const isDark = !lightThemes.includes(theme)
    root.classList.remove('light', 'dark', 'system')
    root.classList.add(isDark ? 'dark' : 'light')
    root.setAttribute('data-theme', theme)
    root.style.setProperty('color-scheme', isDark ? 'dark' : 'light')

    // Demo mode
    try {
      if (new URLSearchParams(window.location.search).get('demo') === '1') {
        document.documentElement.setAttribute('data-demo', 'true');
      }
    } catch {}
  } catch {}
})()
`

const themeColorScript = `
(() => {
  try {
    const root = document.documentElement
    const theme = root.getAttribute('data-theme') || '${DEFAULT_THEME}'
    const colors = {
      'default': '#111216',
      'default-light': '#f7f8fa',
      'claude-nous': '#031A1A',
      'claude-nous-light': '#F8FAF8',
      'claude-official': '#0A0E1A',
      'claude-official-light': '#F7F7F1',
      'claude-classic': '#0d0f12',
      'claude-classic-light': '#F5F2ED',
      'claude-slate': '#0d1117',
      'claude-slate-light': '#F6F8FA',
      'matrix': '#000000',
      'matrix-light': '#F5FFF5',
      'scifi': '#0A1628',
      'scifi-light': '#EEF1F5',
    }
    const nextColor = colors[theme] || colors['${DEFAULT_THEME}']
    const isDark = !['default-light', 'claude-nous-light', 'claude-official-light', 'claude-classic-light', 'claude-slate-light', 'matrix-light', 'scifi-light'].includes(String(theme))

    let meta = document.querySelector('meta[name="theme-color"]')
    if (!meta) {
      meta = document.createElement('meta')
      meta.setAttribute('name', 'theme-color')
      document.head.appendChild(meta)
    }
    meta.setAttribute('content', nextColor)
    root.style.setProperty('color-scheme', isDark ? 'dark' : 'light')
  } catch {}
})()
`

const DEFAULT_SPLASH_HTML = `
<img src="/agorax-icon-512.png" alt="Agorax" style="width:112px;height:112px;margin-bottom:20px;border-radius:16px;filter:drop-shadow(0 8px 32px rgba(232,163,61,0.32))" />
<div style="font:600 32px/1.1 system-ui,-apple-system,sans-serif;color:#FFFFFF;letter-spacing:-0.02em;margin-bottom:8px">Agorax</div>
<div style="font:400 14px/1 system-ui,-apple-system,sans-serif;letter-spacing:0.04em;color:#9CB2AE">The agora for AI agents</div>
<div style="margin-top:28px;width:140px;height:3px;background:rgba(255,255,255,0.08);border-radius:3px;overflow:hidden;position:relative"><div id="splash-bar" style="width:0%;height:100%;background:#FFAC02;border-radius:3px;transition:width 0.4s ease"></div></div>
`

export const Route = createRootRoute({
  head: () => ({
    meta: [
      {
        charSet: 'utf-8',
      },
      {
        name: 'viewport',
        content:
          'width=device-width, initial-scale=1, maximum-scale=1, user-scalable=no, viewport-fit=cover, interactive-widget=resizes-visual',
      },
      {
        title: 'Agorax',
      },
      {
        name: 'description',
        content:
          'The public square for AI agents — chat, orchestration, and multi-agent collaboration.',
      },
      {
        property: 'og:image',
        content: '/cover.png',
      },
      {
        property: 'og:image:type',
        content: 'image/png',
      },
      {
        name: 'twitter:card',
        content: 'summary_large_image',
      },
      {
        name: 'twitter:image',
        content: '/cover.png',
      },
      // PWA meta tags
      {
        name: 'theme-color',
        content: '#0A0E1A',
      },
      {
        name: 'apple-mobile-web-app-capable',
        content: 'yes',
      },
      {
        name: 'apple-mobile-web-app-status-bar-style',
        content: 'default',
      },
    ],
    links: [
      {
        rel: 'stylesheet',
        href: appCss,
      },
      {
        rel: 'icon',
        type: 'image/png',
        href: '/agorax-favicon.png',
      },
      // PWA manifest and icons
      {
        rel: 'manifest',
        href: '/manifest.json',
      },
      {
        rel: 'apple-touch-icon',
        href: '/agorax-apple-touch-icon.png',
        sizes: '180x180',
      },
    ],
  }),

  shellComponent: RootDocument,
  component: RootLayout,
  errorComponent: function RootError({ error }) {
    return (
      <div className="flex flex-col items-center justify-center min-h-screen p-6 text-center bg-primary-50">
        <h1 className="text-2xl font-semibold text-primary-900 mb-4">
          Something went wrong
        </h1>
        <pre className="p-4 bg-primary-100 rounded-lg text-sm text-primary-700 max-w-full overflow-auto mb-6">
          {error instanceof Error ? error.message : String(error)}
        </pre>
        <button
          onClick={() => (window.location.href = '/')}
          className="px-4 py-2 bg-accent-500 text-white rounded-lg hover:bg-accent-600 transition-colors"
        >
          Return Home
        </button>
      </div>
    )
  },
})

const queryClient = new QueryClient()

export function getRootLayoutMode(
  onboardingComplete: string | null,
): 'onboarding' | 'workspace' {
  return onboardingComplete === 'true' ? 'workspace' : 'onboarding'
}

export function wrapInlineScript(source: string): string {
  return `(() => {\n  try {\n${source}\n  } catch (error) {\n    console.error('Inline bootstrap script failed', error)\n  }\n})()`
}

type ServiceWorkerLike = {
  register: (
    scriptURL: string,
    options?: RegistrationOptions,
  ) => Promise<unknown>
}

type CachesLike = {
  keys: () => Promise<Array<string>>
  delete: (name: string) => Promise<boolean> | boolean
}

export async function registerAppServiceWorker({
  serviceWorker,
  cachesApi,
  enabled = import.meta.env.PROD,
}: {
  serviceWorker?: ServiceWorkerLike
  cachesApi?: CachesLike
  enabled?: boolean
}): Promise<void> {
  if (!enabled) return

  await cachesApi
    ?.keys()
    .then((names) =>
      Promise.allSettled(names.map((name) => cachesApi.delete(name))),
    )
    .catch(() => undefined)

  await serviceWorker
    ?.register('/sw.js', { scope: '/' })
    .catch((error: unknown) => {
      console.warn('PWA service worker registration failed', error)
    })
}

function RootLayout() {
  const { settings } = useSettings()
  const [onboardingComplete, setOnboardingComplete] = useState<boolean | null>(
    null,
  )
  const [authStatus, setAuthStatus] = useState<AuthStatus | null>(null)
  const [mounted, setMounted] = useState(false)
  useApplyChatWidth()

  useEffect(() => {
    applyInterfacePreferences(settings)
  }, [settings])

  useEffect(() => {
    void import('../screens/chat/chat-screen')
    setMounted(true)
    initializeSettingsAppearance()

    const syncOnboardingCompletion = () => {
      try {
        setOnboardingComplete(readOnboardingComplete())
      } catch {
        setOnboardingComplete(false)
      }
    }

    if (typeof window === 'undefined') {
      return undefined
    }

    syncOnboardingCompletion()

    void fetch('/api/connection-status', {
      cache: 'no-store',
      signal: AbortSignal.timeout(4_000),
    })
      .then((res) => (res.ok ? res.json() : null))
      .then(
        (
          status: {
            ok?: boolean
            chatReady?: boolean
            modelConfigured?: boolean
          } | null,
        ) => {
          if (status?.ok || (status?.chatReady && status?.modelConfigured)) {
            writeOnboardingComplete(true)
            syncOnboardingCompletion()
          }
        },
      )
      .catch(() => undefined)

    const handleStorage = (event: StorageEvent) => {
      if (
        event.key &&
        event.key !== ONBOARDING_KEY &&
        event.key !== 'claude-onboarding-complete'
      ) {
        return
      }
      syncOnboardingCompletion()
    }

    const handleOnboardingCompleteChanged = () => {
      syncOnboardingCompletion()
    }

    window.addEventListener('storage', handleStorage)
    window.addEventListener(
      ONBOARDING_COMPLETE_EVENT,
      handleOnboardingCompleteChanged,
    )

    void registerAppServiceWorker({
      serviceWorker:
        'serviceWorker' in navigator ? navigator.serviceWorker : undefined,
      cachesApi: 'caches' in window ? caches : undefined,
    })

    return () => {
      window.removeEventListener('storage', handleStorage)
      window.removeEventListener(
        ONBOARDING_COMPLETE_EVENT,
        handleOnboardingCompleteChanged,
      )
    }
  }, [])

  useEffect(() => {
    if (typeof window === 'undefined') return undefined
    let cancelled = false
    fetchClaudeAuthStatus()
      .then((status) => {
        if (!cancelled) setAuthStatus(status)
      })
      .catch(() => {
        if (!cancelled) {
          setAuthStatus({ authenticated: true, authRequired: false })
        }
      })
    return () => {
      cancelled = true
    }
  }, [])

  const rootSurfaceState = getRootSurfaceState(onboardingComplete, authStatus)

  useEffect(() => {
    if (typeof document === 'undefined' || !mounted) return
    document.documentElement.setAttribute('data-app-ready', '1')
    const dismiss = (
      window as Window & { __dismissSplash?: () => void }
    ).__dismissSplash
    dismiss?.()
  }, [mounted])

  return (
    <QueryClientProvider client={queryClient}>
      <Toaster />
      <AttentionToaster />
      <Suspense fallback={null}>
        {mounted && rootSurfaceState.showLogin ? <LoginScreen /> : null}
        {mounted && rootSurfaceState.showOnboarding ? (
          <AgoraxOnboarding />
        ) : null}
      </Suspense>
      {rootSurfaceState.showWorkspaceShell ? (
        <>
          <GlobalShortcutListener />
          <TerminalShortcutListener />
          <WorkspaceShell>
            <ErrorBoundary
              className="h-full min-h-0 flex-1"
              title="Something went wrong"
              description="This page failed to render. Reload to try again."
            >
              <Outlet />
            </ErrorBoundary>
          </WorkspaceShell>
          <Suspense fallback={null}>
            <SearchModal />
            <KeyboardShortcutsModal />
            {rootSurfaceState.showPostOnboardingOverlays ? (
              <>
                <MobilePromptTrigger />
                <OnboardingTour />
              </>
            ) : null}
          </Suspense>
          {/* Keep UsageMeter mounted so search-modal OPEN_USAGE still works even when the pill is hidden by default. */}
          <UsageMeter visible={settings.showUsageMeter} />
          <UpdateCenterNotifier />
        </>
      ) : null}
    </QueryClientProvider>
  )
}

function RootDocument({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" suppressHydrationWarning>
      <head>
        {/* Content-Security-Policy is set as an HTTP response header in
            server-entry.js and vite.config.ts. Don't re-emit it as a `<meta>`
            here — see the comment in src/lib/csp.ts for why duplicating it
            in the HTML is unsafe when an edge proxy mutates the body. */}
        <script
          dangerouslySetInnerHTML={{
            __html: wrapInlineScript(`
          // Recover when Vite returns 504 / mixed optimize-deps hashes after HMR/config reload.
          (function () {
            var reloadKey = 'hermes-vite-dep-reload';
            var isDev = ${import.meta.env.DEV ? 'true' : 'false'};
            if (isDev) {
              try {
                if (navigator.serviceWorker && navigator.serviceWorker.getRegistrations) {
                  navigator.serviceWorker.getRegistrations().then(function (regs) {
                    regs.forEach(function (reg) { void reg.unregister(); });
                  });
                }
                if (window.caches && caches.keys) {
                  caches.keys().then(function (keys) {
                    keys.forEach(function (key) { caches.delete(key); });
                  });
                }
              } catch (_) {}
            }
            function reloadOnce() {
              try {
                var count = Number(sessionStorage.getItem(reloadKey) || '0');
                if (count >= 3) return;
                sessionStorage.setItem(reloadKey, String(count + 1));
              } catch (_) {}
              try {
                if (window.caches && caches.keys) {
                  caches.keys().then(function (keys) {
                    keys.forEach(function (key) { caches.delete(key); });
                  });
                }
              } catch (_) {}
              var bust = '__hermes_v=' + Date.now();
              var base = location.pathname + location.search.replace(/([?&])__hermes_v=[^&]*/g, '$1').replace(/[?&]$/, '');
              location.replace(base + (base.indexOf('?') === -1 ? '?' : '&') + bust);
            }
            function shouldRecover(message) {
              return (
                message.indexOf('Failed to fetch dynamically imported module') !== -1 ||
                message.indexOf('Importing a module script failed') !== -1 ||
                message.indexOf('Invalid hook call') !== -1 ||
                message.indexOf("reading 'useState'") !== -1 ||
                message.indexOf("reading 'useContext'") !== -1 ||
                message.indexOf("reading 'useCallback'") !== -1 ||
                message.indexOf("reading 'useMemo'") !== -1
              );
            }
            function hasMixedViteDepHashes() {
              if (!performance || !performance.getEntriesByType) return false;
              var hashes = {};
              performance.getEntriesByType('resource').forEach(function (entry) {
                var url = entry.name || '';
                if (url.indexOf('.vite/deps/') === -1) return;
                var match = url.match(/[?&]v=([^&]+)/);
                if (match) hashes[match[1]] = true;
              });
              return Object.keys(hashes).length > 1;
            }
            window.addEventListener('vite:preloadError', function (event) {
              if (event && typeof event.preventDefault === 'function') event.preventDefault();
              reloadOnce();
            });
            window.addEventListener('error', function (event) {
              var message = event && event.message ? String(event.message) : '';
              if (shouldRecover(message)) reloadOnce();
            });
            window.addEventListener('unhandledrejection', function (event) {
              var reason = event && event.reason;
              var message = reason && reason.message ? String(reason.message) : String(reason || '');
              if (shouldRecover(message)) reloadOnce();
            });
            window.addEventListener('load', function () {
              if (isDev && hasMixedViteDepHashes()) reloadOnce();
              try { sessionStorage.removeItem(reloadKey); } catch (_) {}
            });
          })();
        `),
          }}
        />
        <script
          dangerouslySetInnerHTML={{
            __html: wrapInlineScript(`
          // Polyfill crypto.randomUUID for non-secure contexts (HTTP access via LAN IP)
          if (typeof crypto !== 'undefined' && !crypto.randomUUID) {
            crypto.randomUUID = function() {
              return ([1e7]+-1e3+-4e3+-8e3+-1e11).replace(/[018]/g, function(c) {
                return (c ^ crypto.getRandomValues(new Uint8Array(1))[0] & 15 >> c / 4).toString(16);
              });
            };
          }
        `),
          }}
        />
        <script
          dangerouslySetInnerHTML={{ __html: wrapInlineScript(themeScript) }}
        />
        <HeadContent />
        <script
          dangerouslySetInnerHTML={{
            __html: wrapInlineScript(themeColorScript),
          }}
        />
      </head>
      <body>
        {/* The inline splash bootstrap mutates this node before React hydrates.
            Keep default splash markup in the server/client tree, then suppress
            parent-level style/theme mutations for this intentionally browser-owned DOM. */}
        <div
          id="splash-screen"
          aria-hidden="true"
          suppressHydrationWarning
          style={{ display: 'none' }}
          dangerouslySetInnerHTML={{ __html: DEFAULT_SPLASH_HTML }}
        />
        <script
          dangerouslySetInnerHTML={{
            __html: wrapInlineScript(`
          (function(){
            var d = document.getElementById('splash-screen');
            if (!d) return;
            var bg = '#111216', txt = '#f6f6f7', muted = 'rgba(255,255,255,0.5)', accent = '#5a9bff';
            try {
              var theme = localStorage.getItem('${THEME_STORAGE_KEY}') || '${DEFAULT_THEME}';
              if (theme === 'webui') theme = 'default';
              if (theme === 'webui-light') theme = 'default-light';
              if (theme === 'default') {
                bg = '#111216';
                txt = '#f6f6f7';
                muted = 'rgba(255,255,255,0.5)';
                accent = '#5a9bff';
              } else if (theme === 'default-light') {
                bg = '#f7f8fa';
                txt = '#29313d';
                muted = 'rgba(60,60,60,0.5)';
                accent = '#4182f5';
              } else if (theme === 'claude-nous') {
                bg = '#031A1A';
                txt = '#F8F1E3';
                muted = '#9CB2AE';
                accent = '#FFAC02';
              } else if (theme === 'claude-nous-light') {
                bg = '#F8FAF8';
                txt = '#16315F';
                muted = '#6F7D96';
                accent = '#2557B7';
              } else if (theme === 'claude-classic') {
                bg = '#0d0f12';
                txt = '#eceff4';
                muted = '#7f8a96';
                accent = '#b98a44';
              } else if (theme === 'claude-official-light') {
                bg = '#F7F7F1';
                txt = '#16315F';
                muted = '#6F7D96';
                accent = '#2557B7';
              } else if (theme === 'claude-classic-light') {
                bg = '#F5F2ED';
                txt = '#1a1f26';
                muted = '#6F675E';
                accent = '#b98a44';
              } else if (theme === 'claude-slate') {
                bg = '#0d1117';
                txt = '#c9d1d9';
                muted = '#8b949e';
                accent = '#7eb8f6';
              } else if (theme === 'claude-slate-light') {
                bg = '#F6F8FA';
                txt = '#24292f';
                muted = '#57606A';
                accent = '#3b82f6';
              }
            } catch(e){}

            var isDark = !['default-light','claude-nous-light','claude-official-light','claude-classic-light','claude-slate-light','matrix-light','scifi-light'].includes(theme);
            var quips = ["Consulting the oracle...","Loading ancient knowledge...","Warming up the messenger...","Calibrating tool chain...","Summoning your agent...","Preparing the workspace...","Bridging realms...","Initializing agent runtime..."];
            var quip = quips[Math.floor(Math.random() * quips.length)];

            d.style.cssText = 'position:fixed;inset:0;z-index:99999;display:flex;flex-direction:column;align-items:center;justify-content:center;background:'+bg+';transition:opacity 0.5s ease;';
            d.innerHTML = '<img src="/agorax-icon-512.png" alt="Agorax" style="width:112px;height:112px;margin-bottom:20px;border-radius:16px;filter:drop-shadow(0 8px 32px rgba(232,163,61,0.32))" />'
              + '<div style="font:600 32px/1.1 system-ui,-apple-system,sans-serif;color:'+txt+';letter-spacing:-0.02em;margin-bottom:8px">Agorax</div>'
              + '<div style="font:400 14px/1 system-ui,-apple-system,sans-serif;letter-spacing:0.04em;color:'+muted+'">The agora for AI agents</div>'
              + '<div style="margin-top:28px;width:140px;height:3px;background:'+(isDark ? 'rgba(255,255,255,0.08)' : 'rgba(0,0,0,0.08)')+';border-radius:3px;overflow:hidden;position:relative"><div id=splash-bar style="width:0%;height:100%;background:'+accent+';border-radius:3px;transition:width 0.4s ease"></div></div>';

            var bar = document.getElementById('splash-bar');
            if (bar) {
              setTimeout(function(){ bar.style.width='15%' }, 300);
              setTimeout(function(){ bar.style.width='40%' }, 800);
              setTimeout(function(){ bar.style.width='65%' }, 1500);
              setTimeout(function(){ bar.style.width='85%' }, 2500);
              setTimeout(function(){ bar.style.width='92%' }, 3200);
            }

            var splashDismissed = false;
            window.__dismissSplash = function() {
              var el = document.getElementById('splash-screen');
              if (!el || splashDismissed) return;
              splashDismissed = true;
              if (bar) bar.style.width = '100%';
              setTimeout(function(){
                el.style.opacity = '0';
                setTimeout(function(){
                  el.innerHTML = '';
                  el.style.cssText = 'display:none';
                }, 200);
              }, 80);
            };
            // Keep the branded splash until React marks the app ready.
            // On Tailscale phones, the JS bundle can take much longer than 2.5s;
            // dismissing early leaves a blank black page with no error UI.
            var start = Date.now();
            function checkReady() {
              if (splashDismissed) return;
              if (document.documentElement.getAttribute('data-app-ready') === '1') {
                window.__dismissSplash && window.__dismissSplash();
                return;
              }
              if (Date.now() - start > 20000) {
                d.innerHTML = '<div style="font:600 20px/1.2 system-ui,sans-serif;color:'+txt+';margin-bottom:12px">Still loading</div>'
                  + '<div style="font:400 14px/1.5 system-ui,sans-serif;color:'+muted+';max-width:280px;text-align:center;margin-bottom:20px">The app shell has not started. On mobile Tailscale this is usually a blocked port, a localhost-only bind, or a stalled JS download.</div>'
                  + '<button type="button" onclick="location.reload()" style="appearance:none;border:0;border-radius:12px;padding:12px 18px;background:'+accent+';color:#fff;font:600 14px system-ui,sans-serif">Reload</button>';
                return;
              }
              setTimeout(checkReady, 200);
            }
            setTimeout(checkReady, 150);
          })()
        `),
          }}
        />
        <div className="root">{children}</div>
        <Scripts />
      </body>
    </html>
  )
}
