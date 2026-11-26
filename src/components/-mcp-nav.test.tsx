import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const FILES = [
  'src/components/dashboard-overflow-panel.tsx',
  'src/components/command-palette.tsx',
  'src/components/mobile-hamburger-menu.tsx',
  'src/components/mobile-tab-bar.tsx',
  'src/components/inspector/inspector-panel.tsx',
  'src/components/search/search-modal.tsx',
  'src/components/workspace-shell.tsx',
] as const

const NAV_REGISTRY = 'src/lib/nav-registry.ts'

describe('MCP nav registration', () => {
  for (const relPath of FILES) {
    it(`${relPath} registers an MCP entry`, () => {
      const source = readFileSync(resolve(process.cwd(), relPath), 'utf8')
      // Most surfaces register the route path "/mcp"; the inspector panel
      // registers an "mcp" tab id rather than a route. Mobile hamburger/tab
      // compose from NAV_ITEMS, so the route lives in nav-registry instead.
      const matchesRoute = /['"`]\/mcp['"`]/.test(source)
      const matchesTabId =
        relPath.endsWith('inspector-panel.tsx') &&
        /id:\s*['"`]mcp['"`]/.test(source)
      const usesNavRegistry =
        (relPath.endsWith('mobile-hamburger-menu.tsx') ||
          relPath.endsWith('mobile-tab-bar.tsx')) &&
        /NAV_ITEMS/.test(source)
      const registry = usesNavRegistry
        ? readFileSync(resolve(process.cwd(), NAV_REGISTRY), 'utf8')
        : ''
      const registryHasMcp =
        usesNavRegistry &&
        /id:\s*['"`]mcp['"`]/.test(registry) &&
        /to:\s*['"`]\/mcp['"`]/.test(registry) &&
        (relPath.endsWith('mobile-hamburger-menu.tsx')
          ? /containers:.*'hamburger'/.test(registry)
          : /containers:.*'tabbar'/.test(registry))
      expect(matchesRoute || matchesTabId || registryHasMcp).toBe(true)
    })
  }
})
