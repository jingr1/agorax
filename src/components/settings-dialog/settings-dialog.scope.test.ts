import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const dialogSrc = () =>
  readFileSync(
    resolve(
      process.cwd(),
      'src/components/settings-dialog/settings-dialog.tsx',
    ),
    'utf8',
  )

const pageSrc = () =>
  readFileSync(
    resolve(process.cwd(), 'src/components/settings/model-provider-scope.tsx'),
    'utf8',
  )

describe('settings model/provider scope wiring', () => {
  it('chat settings dialog reuses shared model panels for the active agent/profile', () => {
    const src = dialogSrc()
    expect(src).toContain('AgentModelPanel')
    expect(src).toContain('ModelProviderScopePanel')
    expect(src).toContain("mode=\"model\"")
    expect(src).toContain('All settings')
    expect(src).not.toContain("action: 'set-default-model'")
    expect(src).not.toContain('showApiKeys={false}')
  })

  it('all settings page uses provider cards above and profile dropdowns below', () => {
    const src = pageSrc()
    const indexSrc = readFileSync(
      resolve(process.cwd(), 'src/routes/settings/index.tsx'),
      'utf8',
    )
    const modelPageSrc = readFileSync(
      resolve(process.cwd(), 'src/components/settings/model-settings-page.tsx'),
      'utf8',
    )
    const catalogSrc = readFileSync(
      resolve(
        process.cwd(),
        'src/components/settings/provider-catalog-panel.tsx',
      ),
      'utf8',
    )
    const profileSrc = readFileSync(
      resolve(
        process.cwd(),
        'src/components/settings/profile-model-selector.tsx',
      ),
      'utf8',
    )
    const agentPanelSrc = readFileSync(
      resolve(process.cwd(), 'src/components/settings/agent-model-panel.tsx'),
      'utf8',
    )
    expect(indexSrc).toContain('ModelSettingsPage')
    expect(modelPageSrc).toContain('ModelProviderScopePanel')
    expect(modelPageSrc).toContain('AgentModelPanel')
    expect(modelPageSrc).toContain("mode=\"provider\"")
    expect(agentPanelSrc).toContain("mode=\"model\"")
    expect(indexSrc).not.toContain('title="Custom Providers"')
    expect(src).toContain('configureOnly')
    expect(src).toContain('ProviderCatalogPanel')
    expect(src).toContain('ProfileModelSelector')
    expect(src.indexOf('<ModelProviderPanel')).toBeLessThan(
      src.indexOf('<ProfileModelSelector'),
    )
    expect(src).toContain('saveProfileModelProvider')
    expect(src).not.toContain('saveAllProfilesModelProvider')
    expect(src).not.toContain('<option value="global">')
    expect(src).toContain("queryKey: ['profiles', 'chat']")
    expect(profileSrc).toContain('Save default')
    expect(profileSrc).toContain('Save fallback')
    expect(catalogSrc).not.toContain('update-manifest')
    expect(catalogSrc).not.toContain('Manifest base URL')
  })

})
