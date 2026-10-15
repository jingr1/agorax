'use client'

import { HugeiconsIcon } from '@hugeicons/react'
import {
  ArrowLeft01Icon,
  Cancel01Icon,
  CheckmarkCircle02Icon,
  CloudIcon,
  CoinsDollarIcon,
  ComputerIcon,
  MessageMultiple01Icon,
  Mic01Icon,
  Moon01Icon,
  Notification03Icon,
  PaintBoardIcon,
  Settings02Icon,
  Sun01Icon,
  UserIcon,
  VolumeHighIcon,
} from '@hugeicons/core-free-icons'
import { Component, useEffect, useState } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { ModelProviderPanel } from './model-provider-panel'
import { ClaudeCodeSettingsPanel } from './claude-code-settings-panel'
import { agentRuntimeLabel } from '@/lib/managed-agent-runtime/agent-targets'
import { CodexSettingsPanel } from './codex-settings-panel'
import { UsagePricingPanel } from './usage-pricing-panel'
import type * as React from 'react'
import type { AccentColor, SettingsThemeMode } from '@/hooks/use-settings'
import type { LoaderStyle } from '@/hooks/use-chat-settings'
import type { BrailleSpinnerPreset } from '@/components/ui/braille-spinner'
import type { ThemeId } from '@/lib/theme'
import type { LocaleId } from '@/lib/i18n'
import type { AgentWithStatus } from '@/lib/agent-types'
import { GROQ_STT_MODELS, STT_PROVIDER_OPTIONS } from '@/lib/stt-config'
import { Button } from '@/components/ui/button'
import { Switch } from '@/components/ui/switch'
import { applyTheme, useSettings } from '@/hooks/use-settings'
import {
  THEMES,
  getTheme,
  getThemeVariant,
  isDarkTheme,
  setTheme,
} from '@/lib/theme'
import { cn } from '@/lib/utils'
import {
  getChatProfileDisplayName,
  useChatSettingsStore,
} from '@/hooks/use-chat-settings'
import { UserAvatar } from '@/components/avatars'
import { Input } from '@/components/ui/input'
import { LogoLoader } from '@/components/logo-loader'
import { BrailleSpinner } from '@/components/ui/braille-spinner'
import { ThreeDotsSpinner } from '@/components/ui/three-dots-spinner'
import BackendUnavailableState from '@/components/backend-unavailable-state'
import { applyAccentColor } from '@/lib/accent-colors'
import { getUnavailableReason } from '@/lib/feature-gates'
import { useFeatureAvailable } from '@/hooks/use-feature-available'
import { useProfiles } from '@/screens/chat/hooks/use-profiles'
import {
  profileConfigPathLabel,
  readModelProviderFromConfig,
  saveProfileModelProvider,
} from '@/lib/model-provider'
import { useProviderCatalog } from '@/components/settings/provider-catalog-panel'
import { fetchAgents } from '@/lib/agent-api'
import {
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogRoot,
  DialogTitle,
} from '@/components/ui/dialog'
import { LOCALE_LABELS, getLocale, setLocale } from '@/lib/i18n'

export {
  getOAuthStartButtonLabel,
  getProviderClickAction,
  type OAuthStatus,
  type ProviderClickAction,
} from './model-provider-panel'

// ── Types ───────────────────────────────────────────────────────────────

type SectionId =
  | 'profile'
  | 'claude'
  | 'agent'
  | 'voice'
  | 'display'
  | 'appearance'
  | 'chat'
  | 'notifications'
  | 'language'
  | 'usage_pricing'

const SECTIONS: Array<{ id: SectionId; label: string; icon: any }> = [
  { id: 'profile', label: 'Profile', icon: UserIcon },
  { id: 'claude', label: 'Model & Provider', icon: CloudIcon },
  { id: 'usage_pricing', label: 'Usage Pricing', icon: CoinsDollarIcon },
  { id: 'agent', label: 'Agent', icon: Settings02Icon },
  { id: 'voice', label: 'Voice', icon: VolumeHighIcon },
  { id: 'display', label: 'Display', icon: PaintBoardIcon },
  { id: 'appearance', label: 'Theme', icon: PaintBoardIcon },
  { id: 'chat', label: 'Chat', icon: MessageMultiple01Icon },
  { id: 'notifications', label: 'Alerts', icon: Notification03Icon },
  { id: 'language', label: 'Language', icon: MessageMultiple01Icon },
]

const DARK_ENTERPRISE_THEMES = new Set<ThemeId>([
  'claude-nous',
  'claude-official',
  'claude-classic',
  'claude-slate',
])

function _isDarkEnterpriseTheme(theme: string | null): theme is ThemeId {
  if (!theme) return false
  return DARK_ENTERPRISE_THEMES.has(theme as ThemeId)
}
void _isDarkEnterpriseTheme

// ── Shared building blocks ──────────────────────────────────────────────

function SectionHeader({
  title,
  description,
}: {
  title: string
  description: string
}) {
  return (
    <div className="mb-2">
      <p className="mb-2 text-xs font-semibold uppercase tracking-wider text-primary-500">
        Settings
      </p>
      <h3 className="text-base font-semibold text-primary-900 dark:text-neutral-100">
        {title}
      </h3>
      <p className="text-xs text-primary-500 dark:text-neutral-400">
        {description}
      </p>
    </div>
  )
}

function Row({
  label,
  description,
  children,
}: {
  label: string
  description?: string
  children: React.ReactNode
}) {
  return (
    <div className="flex flex-wrap items-center justify-between gap-4 py-1.5">
      <div className="min-w-0 flex-1">
        <p className="text-sm font-medium text-primary-900 dark:text-neutral-100">
          {label}
        </p>
        {description && (
          <p className="text-xs text-primary-500 dark:text-neutral-400">
            {description}
          </p>
        )}
      </div>
      <div className="flex items-center gap-2">{children}</div>
    </div>
  )
}

const SETTINGS_CARD_CLASS =
  'rounded-xl border border-primary-200 bg-primary-50/80 px-4 py-3 shadow-sm'

// ── Section components ──────────────────────────────────────────────────

function HermesContent({ profileName }: { profileName?: string }) {
  const configAvailable = useFeatureAvailable('config')
  const queryClient = useQueryClient()
  const { activeProfileName, isReady } = useProfiles()
  const { catalog } = useProviderCatalog()
  const [initialProvider, setInitialProvider] = useState('')
  const [initialModel, setInitialModel] = useState('')
  const [loaded, setLoaded] = useState(false)
  const [memEnabled, setMemEnabled] = useState(true)
  const [userProfileEnabled, setUserProfileEnabled] = useState(true)

  const targetProfileName = profileName || activeProfileName

  useEffect(() => {
    if (!isReady) return
    let cancelled = false
    setLoaded(false)
    fetch(`/api/profiles/read?name=${encodeURIComponent(targetProfileName)}`)
      .then((r) => r.json())
      .then((d: { profile?: { config?: Record<string, unknown> } }) => {
        if (cancelled) return
        const mp = readModelProviderFromConfig(d.profile?.config)
        setInitialProvider(mp.provider)
        setInitialModel(mp.model)
        setLoaded(true)
      })
      .catch(() => {
        if (!cancelled) setLoaded(true)
      })
    return () => {
      cancelled = true
    }
  }, [targetProfileName, isReady])

  useEffect(() => {
    fetch('/api/hermes-config')
      .then((r) => r.json())
      .then((d: { config?: { memory?: Record<string, unknown> } }) => {
        const mem = d.config?.memory ?? {}
        setMemEnabled(mem.memory_enabled !== false)
        setUserProfileEnabled(mem.user_profile_enabled !== false)
      })
      .catch(() => {})
  }, [])

  const saveMemory = async (patch: Record<string, unknown>) => {
    try {
      await fetch('/api/hermes-config', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ config: { memory: patch } }),
      })
    } catch {
      // Memory remains a global toggle; ignore network errors after optimistic UI.
    }
  }

  if (!configAvailable) {
    return (
      <BackendUnavailableState
        feature="Hermes Agent Settings"
        description={getUnavailableReason('config')}
      />
    )
  }

  const cardStyle: React.CSSProperties = {
    backgroundColor: 'var(--theme-card)',
    border: '1px solid var(--theme-border)',
    color: 'var(--theme-text)',
  }
  const mutedStyle: React.CSSProperties = { color: 'var(--theme-muted)' }

  return (
    <div className="space-y-5">
      <SectionHeader
        title="Model & Provider"
        description={`Active profile: ${targetProfileName}. Changes apply only to this profile.`}
      />
      {loaded ? (
        <ModelProviderPanel
          key={`${targetProfileName}:${catalog?.providers.map((p) => p.id).join(',')}`}
          initialProvider={initialProvider}
          initialModel={initialModel}
          banner={`Editing profile ${targetProfileName}. Use All settings for global or other profiles.`}
          configPathLabel={profileConfigPathLabel(targetProfileName)}
          showApiKeys={false}
          extraProviders={catalog?.providers ?? []}
          onSetDefault={async (providerId, modelId) => {
            const message = await saveProfileModelProvider(
              targetProfileName,
              providerId,
              modelId,
            )
            void queryClient.invalidateQueries({
              queryKey: ['profiles', 'chat'],
            })
            void queryClient.invalidateQueries({
              queryKey: ['claude', 'models'],
            })
            return message
          }}
        />
      ) : (
        <div className="h-20 animate-pulse rounded-lg bg-primary-100/70 dark:bg-neutral-800" />
      )}

      <div>
        <p
          className="mb-1 text-xs font-semibold uppercase tracking-wider"
          style={mutedStyle}
        >
          Memory
        </p>
        <div className="space-y-1.5">
          <div
            className="flex items-center justify-between rounded-xl px-3 py-2.5"
            style={cardStyle}
          >
            <div>
              <div className="text-sm font-medium">Memory</div>
              <div className="text-[11px]" style={mutedStyle}>
                Store & recall memories across sessions
              </div>
            </div>
            <Switch
              checked={memEnabled}
              onCheckedChange={(c) => {
                setMemEnabled(c)
                void saveMemory({ memory_enabled: c })
              }}
            />
          </div>
          <div
            className="flex items-center justify-between rounded-xl px-3 py-2.5"
            style={cardStyle}
          >
            <div>
              <div className="text-sm font-medium">User Profile</div>
              <div className="text-[11px]" style={mutedStyle}>
                Remember preferences & context
              </div>
            </div>
            <Switch
              checked={userProfileEnabled}
              onCheckedChange={(c) => {
                setUserProfileEnabled(c)
                void saveMemory({ user_profile_enabled: c })
              }}
            />
          </div>
        </div>
      </div>
    </div>
  )
}

function ProfileContent() {
  const { settings: cs, updateSettings: updateCS } = useChatSettingsStore()
  const [profileError, setProfileError] = useState<string | null>(null)
  const [processing, setProcessing] = useState(false)
  const displayName = getChatProfileDisplayName(cs.displayName)
  const [nameError, setNameError] = useState<string | null>(null)

  function handleNameChange(value: string) {
    if (value.length > 50) {
      setNameError('Display name too long (max 50 characters)')
      return
    }
    setNameError(null)
    updateCS({ displayName: value })
  }

  async function handleAvatarUpload(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0]
    e.target.value = ''
    if (!file) return
    if (!file.type.startsWith('image/')) {
      setProfileError('Unsupported file type.')
      return
    }
    if (file.size > 10 * 1024 * 1024) {
      setProfileError('Image too large (max 10MB).')
      return
    }
    setProfileError(null)
    setProcessing(true)
    try {
      const url = URL.createObjectURL(file)
      const img = await new Promise<HTMLImageElement>((resolve, reject) => {
        const i = new Image()
        i.onload = () => resolve(i)
        i.onerror = () => reject(new Error('Failed'))
        i.src = url
      })
      const max = 128,
        scale = Math.min(1, max / Math.max(img.width, img.height))
      const w = Math.round(img.width * scale),
        h = Math.round(img.height * scale)
      const canvas = document.createElement('canvas')
      canvas.width = w
      canvas.height = h
      const ctx = canvas.getContext('2d')!
      ctx.imageSmoothingQuality = 'high'
      ctx.drawImage(img, 0, 0, w, h)
      URL.revokeObjectURL(url)
      updateCS({
        avatarDataUrl: canvas.toDataURL(
          file.type === 'image/png' ? 'image/png' : 'image/jpeg',
          0.82,
        ),
      })
    } catch {
      setProfileError('Failed to process image.')
    } finally {
      setProcessing(false)
    }
  }

  const errorId = 'profile-name-error'

  return (
    <div className="space-y-4">
      <SectionHeader
        title="Profile"
        description="Your display identity in chat."
      />
      <div className={SETTINGS_CARD_CLASS}>
        <div className="flex items-center gap-3">
          <UserAvatar size={44} src={cs.avatarDataUrl} alt={displayName} />
          <div>
            <p className="text-sm font-medium text-primary-900 dark:text-neutral-100">
              {displayName}
            </p>
            <p className="text-xs text-primary-500 dark:text-neutral-400">
              No email connected
            </p>
          </div>
        </div>
      </div>
      <div className={SETTINGS_CARD_CLASS}>
        <Row label="Display name" description="Shown in chat and sidebar">
          <div className="w-full max-w-xs">
            <Input
              value={cs.displayName}
              onChange={(e) => handleNameChange(e.target.value)}
              placeholder="User"
              className="h-8 w-full rounded-lg border-primary-200 text-sm"
              maxLength={50}
              aria-label="Display name"
              aria-invalid={!!nameError}
              aria-describedby={nameError ? errorId : undefined}
            />
            {nameError && (
              <p
                id={errorId}
                className="mt-1 text-xs text-red-600"
                role="alert"
              >
                {nameError}
              </p>
            )}
          </div>
        </Row>
        <Row label="Avatar">
          <div className="flex items-center gap-2">
            <label className="block">
              <input
                type="file"
                accept="image/*"
                onChange={handleAvatarUpload}
                disabled={processing}
                aria-label="Upload profile picture"
                className="block max-w-[13rem] cursor-pointer text-xs text-primary-700 dark:text-neutral-300 file:mr-2 file:cursor-pointer file:rounded-lg file:border file:border-primary-200 file:bg-primary-100 file:px-2.5 file:py-1.5 file:text-xs file:font-medium file:text-primary-900 file:transition-colors hover:file:bg-primary-200 disabled:cursor-not-allowed disabled:opacity-50"
              />
            </label>
            <Button
              variant="outline"
              size="sm"
              onClick={() => updateCS({ avatarDataUrl: null })}
              disabled={!cs.avatarDataUrl || processing}
              className="h-8 rounded-lg border-primary-200 px-3"
            >
              Remove
            </Button>
          </div>
          {profileError && (
            <p className="text-xs text-red-600" role="alert">
              {profileError}
            </p>
          )}
        </Row>
      </div>
    </div>
  )
}

function AppearanceContent() {
  const { settings, updateSettings } = useSettings()

  function handleThemeChange(value: string) {
    const theme = value as SettingsThemeMode
    applyTheme(theme)
    if (theme === 'light' || theme === 'dark') {
      setTheme(getThemeVariant(getTheme(), theme))
    }
    updateSettings({ theme })
  }

  function _badgeClass(color: AccentColor): string {
    if (color === 'orange') return 'bg-orange-500'
    if (color === 'purple') return 'bg-purple-500'
    if (color === 'blue') return 'bg-blue-500'
    return 'bg-green-500'
  }

  function _handleAccentColorChange(selectedAccent: AccentColor) {
    localStorage.setItem('claude-accent', selectedAccent)
    document.documentElement.setAttribute('data-accent', selectedAccent)
    applyAccentColor(selectedAccent)
    updateSettings({ accentColor: selectedAccent })
  }

  return (
    <div className="space-y-4">
      <SectionHeader
        title="Appearance"
        description="Theme and color accents."
      />
      <div className={SETTINGS_CARD_CLASS}>
        <p className="mb-2 text-xs font-semibold uppercase tracking-wider text-primary-500">
          Theme Mode
        </p>
        <div className="inline-flex rounded-lg border border-primary-200 p-1">
          {[
            { value: 'light', label: 'Light', icon: Sun01Icon },
            { value: 'dark', label: 'Dark', icon: Moon01Icon },
            { value: 'system', label: 'System', icon: ComputerIcon },
          ].map((option) => (
            <button
              key={option.value}
              type="button"
              onClick={() => handleThemeChange(option.value)}
              className={cn(
                'flex items-center gap-1.5 rounded-md px-3 py-1.5 text-sm transition-colors',
                settings.theme === option.value
                  ? 'bg-accent-500 text-white'
                  : 'text-primary-600 hover:bg-primary-100',
              )}
            >
              <HugeiconsIcon icon={option.icon} size={16} strokeWidth={1.5} />
              {option.label}
            </button>
          ))}
        </div>
      </div>
      {/* Accent color removed — themes control accent */}
      <div className={SETTINGS_CARD_CLASS}>
        <p className="mb-2 text-xs font-semibold uppercase tracking-wider text-primary-500">
          Enterprise Theme
        </p>
        <EnterpriseThemePicker />
      </div>
      <div className={SETTINGS_CARD_CLASS}>
        <Row
          label="System metrics footer"
          description="Show a persistent footer with CPU, RAM, disk, and Hermes Agent status."
        >
          <Switch
            checked={settings.showSystemMetricsFooter}
            onCheckedChange={(c) =>
              updateSettings({ showSystemMetricsFooter: c })
            }
            aria-label="Show system metrics footer"
          />
        </Row>

        {/* Mobile chat nav removed — not relevant for Hermes */}
      </div>
    </div>
  )
}

const ENTERPRISE_THEME_FAMILIES: Array<ThemeId> = [
  'default',
  'claude-nous',
  'matrix',
  'claude-official',
  'claude-classic',
  'claude-slate',
]

const ENTERPRISE_THEMES = THEMES.map((theme) => ({
  ...theme,
  desc: theme.description,
  preview:
    theme.id === 'claude-nous'
      ? {
          bg: '#041C1C',
          panel: '#06282A',
          border: 'rgba(255,230,203,0.2)',
          accent: '#FFAC02',
          text: '#FFE6CB',
        }
      : theme.id === 'claude-nous-light'
        ? {
            bg: '#F8FAF8',
            panel: '#FBFDFB',
            border: 'rgba(30,74,92,0.18)',
            accent: '#2557B7',
            text: '#16315F',
          }
        : theme.id === 'matrix'
          ? {
              bg: '#020804',
              panel: '#07130A',
              border: 'rgba(0,255,65,0.28)',
              accent: '#00FF41',
              text: '#D8FFE3',
            }
          : theme.id === 'matrix-light'
            ? {
                bg: '#F4FFF6',
                panel: '#FFFFFF',
                border: 'rgba(0,126,34,0.2)',
                accent: '#008F2D',
                text: '#062A12',
              }
            : theme.id === 'claude-official'
              ? {
                  bg: '#0A0E1A',
                  panel: '#11182A',
                  border: '#24304A',
                  accent: '#6366F1',
                  text: '#E6EAF2',
                }
              : theme.id === 'claude-official-light'
                ? {
                    bg: '#F7F7F1',
                    panel: '#FAFBF6',
                    border: '#CDD5DA',
                    accent: '#2557B7',
                    text: '#16315F',
                  }
                : theme.id === 'claude-classic'
                  ? {
                      bg: '#0d0f12',
                      panel: '#1a1f26',
                      border: '#2a313b',
                      accent: '#b98a44',
                      text: '#eceff4',
                    }
                  : theme.id === 'claude-classic-light'
                    ? {
                        bg: '#F5F2ED',
                        panel: '#FCFAF7',
                        border: '#D8CCBC',
                        accent: '#b98a44',
                        text: '#1a1f26',
                      }
                    : theme.id === 'claude-slate'
                      ? {
                          bg: '#0d1117',
                          panel: '#1c2128',
                          border: '#30363d',
                          accent: '#7eb8f6',
                          text: '#c9d1d9',
                        }
                      : theme.id === 'default'
                        ? {
                            bg: '#111216',
                            panel: '#1a1c22',
                            border: '#30333b',
                            accent: '#5a9bff',
                            text: '#f6f6f7',
                          }
                        : theme.id === 'default-light'
                          ? {
                              bg: '#f7f8fa',
                              panel: '#f8fafc',
                              border: '#e5e7eb',
                              accent: '#4182f5',
                              text: '#29313d',
                            }
                          : {
                              bg: '#F6F8FA',
                              panel: '#FFFFFF',
                              border: '#D0D7DE',
                              accent: '#3b82f6',
                              text: '#24292f',
                            },
}))

function ThemeSwatch({
  colors,
}: {
  colors: (typeof ENTERPRISE_THEMES)[number]['preview']
}) {
  return (
    <div
      className="flex h-10 w-full overflow-hidden rounded-md border"
      style={{ borderColor: colors.border, backgroundColor: colors.bg }}
    >
      <div
        className="flex h-full w-4 flex-col gap-0.5 p-0.5"
        style={{ backgroundColor: colors.panel }}
      >
        {[1, 2, 3].map((i) => (
          <div
            key={i}
            className="h-1.5 w-full rounded-sm"
            style={{ backgroundColor: colors.border }}
          />
        ))}
      </div>
      <div className="flex flex-1 flex-col gap-0.5 p-1">
        <div
          className="h-1.5 w-3/4 rounded"
          style={{ backgroundColor: colors.text, opacity: 0.8 }}
        />
        <div
          className="h-1 w-1/2 rounded"
          style={{ backgroundColor: colors.text, opacity: 0.3 }}
        />
        <div
          className="mt-0.5 h-1.5 w-6 rounded-full"
          style={{ backgroundColor: colors.accent }}
        />
      </div>
    </div>
  )
}

function EnterpriseThemePicker() {
  const { updateSettings } = useSettings()
  const [current, setCurrent] = useState(() => {
    if (typeof window === 'undefined') return 'claude-nous'
    return getTheme()
  })
  const currentMode = isDarkTheme(current) ? 'dark' : 'light'

  useEffect(() => {
    setCurrent(getTheme())
  }, [])

  function applyEnterpriseTheme(id: ThemeId) {
    setTheme(id)
    updateSettings({ theme: isDarkTheme(id) ? 'dark' : 'light' })
    setCurrent(id)
  }

  function toggleEnterpriseThemeMode() {
    const nextMode = currentMode === 'dark' ? 'light' : 'dark'
    applyEnterpriseTheme(getThemeVariant(current, nextMode))
  }

  const visibleThemes = ENTERPRISE_THEME_FAMILIES.map((themeId) =>
    ENTERPRISE_THEMES.find(
      (theme) => theme.id === getThemeVariant(themeId, currentMode),
    ),
  ).filter(Boolean) as typeof ENTERPRISE_THEMES

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between rounded-lg border border-primary-200 px-3 py-2">
        <div>
          <p className="text-xs font-semibold text-primary-900 dark:text-neutral-100">
            {currentMode === 'dark' ? 'Dark mode' : 'Light mode'}
          </p>
          <p className="text-[11px] text-primary-500 dark:text-neutral-400">
            Toggle the current theme family between paired light and dark
            variants.
          </p>
        </div>
        <button
          type="button"
          onClick={toggleEnterpriseThemeMode}
          className="inline-flex items-center gap-2 rounded-lg border border-primary-200 bg-primary-50 px-3 py-1.5 text-xs font-medium text-primary-900 transition-colors hover:bg-primary-100"
          aria-label={
            currentMode === 'dark'
              ? 'Switch enterprise theme to light mode'
              : 'Switch enterprise theme to dark mode'
          }
        >
          <HugeiconsIcon
            icon={currentMode === 'dark' ? Sun01Icon : Moon01Icon}
            size={16}
            strokeWidth={1.5}
          />
          {currentMode === 'dark' ? 'Light' : 'Dark'}
        </button>
      </div>
      <div className="grid w-full grid-cols-2 gap-2">
        {visibleThemes.map((t) => {
          const isActive = current === t.id
          return (
            <button
              key={t.id}
              type="button"
              onClick={() => applyEnterpriseTheme(t.id)}
              className={cn(
                'flex flex-col gap-1.5 rounded-lg border p-2 text-left transition-colors',
                isActive
                  ? 'border-accent-500 bg-accent-50 text-accent-700'
                  : 'border-primary-200 bg-primary-50/80 hover:bg-primary-100',
              )}
            >
              <ThemeSwatch colors={t.preview} />
              <div className="flex items-center gap-1">
                <span className="text-xs">{t.icon}</span>
                <span className="text-xs font-semibold text-primary-900 dark:text-neutral-100">
                  {t.label}
                </span>
                {isActive && (
                  <span className="ml-auto text-[9px] font-bold text-accent-600 uppercase tracking-wide">
                    Active
                  </span>
                )}
              </div>
              <p className="text-[10px] text-primary-500 dark:text-neutral-400 leading-tight">
                {t.desc}
              </p>
            </button>
          )
        })}
      </div>
    </div>
  )
}

function _LoaderContent() {
  const { settings: cs, updateSettings: updateCS } = useChatSettingsStore()
  const styles: Array<{ value: LoaderStyle; label: string }> = [
    { value: 'dots', label: 'Dots' },
    { value: 'braille-claude', label: 'Hermes' },
    { value: 'braille-orbit', label: 'Orbit' },
    { value: 'braille-breathe', label: 'Breathe' },
    { value: 'braille-pulse', label: 'Pulse' },
    { value: 'braille-wave', label: 'Wave' },
    { value: 'lobster', label: 'Lobster' },
    { value: 'logo', label: 'Logo' },
  ]
  function getPreset(s: LoaderStyle): BrailleSpinnerPreset | null {
    const m: Record<string, BrailleSpinnerPreset> = {
      'braille-claude': 'claude',
      'braille-orbit': 'orbit',
      'braille-breathe': 'breathe',
      'braille-pulse': 'pulse',
      'braille-wave': 'wave',
    }
    return m[s] ?? null
  }
  function Preview({ style }: { style: LoaderStyle }) {
    if (style === 'dots') return <ThreeDotsSpinner />
    if (style === 'lobster')
      return <span className="inline-block text-sm animate-pulse">🦞</span>
    if (style === 'logo') return <LogoLoader />
    const p = getPreset(style)
    return p ? (
      <BrailleSpinner
        preset={p}
        size={16}
        speed={120}
        className="text-primary-500"
      />
    ) : (
      <ThreeDotsSpinner />
    )
  }
  return (
    <div>
      <p className="mb-2 text-xs font-semibold uppercase tracking-wider text-primary-500">
        Loading animation
      </p>
      <div className="grid grid-cols-4 gap-2">
        {styles.map((o) => (
          <button
            key={o.value}
            type="button"
            onClick={() => updateCS({ loaderStyle: o.value })}
            className={cn(
              'flex min-h-14 flex-col items-center justify-center gap-1.5 rounded-lg border px-1.5 py-1.5 transition-colors',
              cs.loaderStyle === o.value
                ? 'border-accent-500 bg-accent-50 text-accent-700'
                : 'border-primary-200 bg-primary-50/80 text-primary-700 hover:bg-primary-100',
            )}
            aria-pressed={cs.loaderStyle === o.value}
          >
            <span className="flex h-4 items-center justify-center">
              <Preview style={o.value} />
            </span>
            <span className="text-[10px] font-medium leading-3">{o.label}</span>
          </button>
        ))}
      </div>
    </div>
  )
}

function ChatContent() {
  const { settings: cs, updateSettings: updateCS } = useChatSettingsStore()
  return (
    <div className="space-y-4">
      <SectionHeader
        title="Chat"
        description="Message visibility and response loader style."
      />
      <div className={SETTINGS_CARD_CLASS}>
        <Row
          label="Show tool messages"
          description="Display tool call details in assistant responses."
        >
          <Switch
            checked={cs.showToolMessages}
            onCheckedChange={(c) => updateCS({ showToolMessages: c })}
            aria-label="Show tool messages"
          />
        </Row>
        <Row
          label="Show reasoning blocks"
          description="Display model reasoning blocks when available."
        >
          <Switch
            checked={cs.showReasoningBlocks}
            onCheckedChange={(c) => updateCS({ showReasoningBlocks: c })}
            aria-label="Show reasoning blocks"
          />
        </Row>
        <Row
          label="Sound on response complete"
          description="Play a short sound in the browser when the agent finishes replying."
        >
          <Switch
            checked={cs.soundOnChatComplete}
            onCheckedChange={(c) => updateCS({ soundOnChatComplete: c })}
            aria-label="Sound on response complete"
          />
        </Row>
        <Row
          label="Enter key behavior"
          description={
            cs.enterBehavior === 'newline'
              ? 'Enter inserts a newline. Use ⌘/Ctrl+Enter to send.'
              : 'Enter sends the message. Use Shift+Enter for a newline.'
          }
        >
          <Switch
            checked={cs.enterBehavior === 'newline'}
            onCheckedChange={(c) =>
              updateCS({ enterBehavior: c ? 'newline' : 'send' })
            }
            aria-label="Enter inserts newline instead of sending"
          />
        </Row>
        <Row
          label="Busy message mode"
          description="When the agent is replying: queue follow-ups, interrupt, or steer the live turn."
        >
          <select
            value={cs.busyMessageMode ?? 'queue'}
            onChange={(e) =>
              updateCS({
                busyMessageMode: e.target.value as
                  | 'queue'
                  | 'interrupt'
                  | 'steer',
              })
            }
            className="h-8 rounded-md border border-primary-200 bg-primary-50 px-2 text-sm text-primary-900 outline-none transition-colors focus-visible:ring-2 focus-visible:ring-primary-400"
            aria-label="Busy message mode"
          >
            <option value="queue">Queue (after reply)</option>
            <option value="interrupt">Interrupt and send</option>
            <option value="steer">Steer live reply</option>
          </select>
        </Row>
        <Row
          label="Activity display"
          description="How tool calls and thinking appear while the agent works."
        >
          <select
            value={cs.chatActivityDisplayMode ?? 'compact'}
            onChange={(e) =>
              updateCS({
                chatActivityDisplayMode: e.target.value as
                  | 'compact'
                  | 'stream'
                  | 'hidden',
              })
            }
            className="h-8 rounded-md border border-primary-200 bg-primary-50 px-2 text-sm text-primary-900 outline-none transition-colors focus-visible:ring-2 focus-visible:ring-primary-400"
            aria-label="Activity display mode"
          >
            <option value="compact">Compact worklog</option>
            <option value="stream">Expanded stream</option>
            <option value="hidden">Hide activity</option>
          </select>
        </Row>
        <Row
          label="Conversation outline"
          description="Desktop jump list of user questions in the current chat."
        >
          <Switch
            checked={cs.showConversationOutline === true}
            onCheckedChange={(c) => updateCS({ showConversationOutline: c })}
            aria-label="Show conversation outline"
          />
        </Row>
        <Row
          label="Chat content width"
          description="Max-width of the message column on wide screens."
        >
          <select
            value={cs.chatWidth}
            onChange={(e) =>
              updateCS({
                chatWidth: e.target.value as 'comfortable' | 'wide' | 'full',
              })
            }
            className="h-8 rounded-md border border-primary-200 bg-primary-50 px-2 text-sm text-primary-900 outline-none transition-colors focus-visible:ring-2 focus-visible:ring-primary-400"
            aria-label="Chat content width"
          >
            <option value="comfortable">Comfortable (900px)</option>
            <option value="wide">Wide (1200px)</option>
            <option value="full">Full width</option>
          </select>
        </Row>
        <Row
          label="Expand sidebar on hover"
          description={
            cs.sidebarHoverExpand
              ? 'Collapsed sidebar expands temporarily on hover.'
              : 'Collapsed sidebar stays at 48px until you click the toggle.'
          }
        >
          <Switch
            checked={cs.sidebarHoverExpand}
            onCheckedChange={(c) => updateCS({ sidebarHoverExpand: c })}
            aria-label="Expand sidebar on hover"
          />
        </Row>
      </div>
      {/* Loading animation removed — not relevant for Hermes */}
    </div>
  )
}

function NotificationsContent() {
  const { settings, updateSettings } = useSettings()
  return (
    <div className="space-y-4">
      <SectionHeader
        title="Notifications"
        description="Simple alerts and threshold controls."
      />
      <div className={SETTINGS_CARD_CLASS}>
        <Row label="Enable alerts">
          <Switch
            checked={settings.notificationsEnabled}
            onCheckedChange={(c) => updateSettings({ notificationsEnabled: c })}
            aria-label="Enable alerts"
          />
        </Row>
        <Row label="Usage threshold">
          <div className="flex w-full max-w-[14rem] items-center gap-2">
            <input
              type="range"
              min={50}
              max={100}
              value={settings.usageThreshold}
              onChange={(e) =>
                updateSettings({ usageThreshold: Number(e.target.value) })
              }
              className="w-full accent-primary-900 dark:accent-primary-400 disabled:cursor-not-allowed disabled:opacity-50"
              disabled={!settings.notificationsEnabled}
              aria-label={`Usage threshold: ${settings.usageThreshold} percent`}
              aria-valuemin={50}
              aria-valuemax={100}
              aria-valuenow={settings.usageThreshold}
            />
            <span className="w-10 text-right text-sm tabular-nums text-primary-700 dark:text-neutral-300">
              {settings.usageThreshold}%
            </span>
          </div>
        </Row>
      </div>
    </div>
  )
}

function _AdvancedContent() {
  const { settings, updateSettings } = useSettings()
  const [connectionStatus, setConnectionStatus] = useState<
    'idle' | 'testing' | 'connected' | 'failed'
  >('idle')
  const [urlError, setUrlError] = useState<string | null>(null)

  function validateAndUpdateUrl(value: string) {
    if (value && value.length > 0) {
      try {
        new URL(value)
        setUrlError(null)
      } catch {
        setUrlError('Invalid URL format')
      }
    } else {
      setUrlError(null)
    }
    updateSettings({ claudeUrl: value })
  }

  async function testConnection() {
    if (urlError) return
    setConnectionStatus('testing')
    try {
      const r = await fetch('/api/ping')
      setConnectionStatus(r.ok ? 'connected' : 'failed')
    } catch {
      setConnectionStatus('failed')
    }
  }

  const urlErrorId = 'claude-url-error'

  return (
    <div className="space-y-4">
      <SectionHeader
        title="Advanced"
        description="Hermes Agent endpoint and connectivity."
      />
      <div className={SETTINGS_CARD_CLASS}>
        <Row
          label="Hermes Agent URL"
          description="Used for API requests from Studio"
        >
          <div className="w-full max-w-sm">
            <Input
              type="url"
              placeholder="https://api.claudeworkspace.app"
              value={settings.claudeUrl}
              onChange={(e) => validateAndUpdateUrl(e.target.value)}
              className="h-8 w-full rounded-lg border-primary-200 text-sm"
              aria-label="Hermes Agent URL"
              aria-invalid={!!urlError}
              aria-describedby={urlError ? urlErrorId : undefined}
            />
            {urlError && (
              <p
                id={urlErrorId}
                className="mt-1 text-xs text-red-600"
                role="alert"
              >
                {urlError}
              </p>
            )}
          </div>
        </Row>
        <Row label="Connection status">
          <span
            className={cn(
              'inline-flex items-center gap-1.5 rounded-full border px-2 py-0.5 text-xs font-medium',
              connectionStatus === 'connected' &&
                'border-green-500/35 bg-green-500/10 text-green-600',
              connectionStatus === 'failed' &&
                'border-red-500/35 bg-red-500/10 text-red-600',
              connectionStatus === 'testing' &&
                'border-accent-500/35 bg-accent-500/10 text-accent-600',
              connectionStatus === 'idle' &&
                'border-primary-300 bg-primary-100 text-primary-700',
            )}
          >
            {connectionStatus === 'idle'
              ? 'Not tested'
              : connectionStatus === 'testing'
                ? 'Testing...'
                : connectionStatus === 'connected'
                  ? 'Connected'
                  : 'Failed'}
          </span>
          <Button
            variant="outline"
            size="sm"
            onClick={() => void testConnection()}
            disabled={connectionStatus === 'testing' || !!urlError}
            className="h-8 rounded-lg border-primary-200 px-3"
          >
            <HugeiconsIcon
              icon={CheckmarkCircle02Icon}
              size={16}
              strokeWidth={1.5}
            />
            Test
          </Button>
        </Row>
      </div>
    </div>
  )
}

// ── Error Boundary ──────────────────────────────────────────────────────

class SettingsErrorBoundary extends Component<
  { children: React.ReactNode },
  { error: Error | null }
> {
  state = { error: null as Error | null }

  static getDerivedStateFromError(error: Error) {
    return { error }
  }

  render() {
    if (this.state.error) {
      return (
        <div className="flex h-full items-center justify-center p-8 text-center">
          <div>
            <p className="mb-2 text-sm font-medium text-red-500">
              Settings failed to load
            </p>
            <button
              onClick={() => this.setState({ error: null })}
              className="text-xs text-primary-600 underline hover:text-primary-900"
            >
              Try again
            </button>
          </div>
        </div>
      )
    }
    return this.props.children
  }
}

// ── Agent Behavior ──────────────────────────────────────────────────────

function AgentBehaviorContent() {
  const [config, setConfig] = useState<Record<string, unknown>>({})
  const [msg, setMsg] = useState<string | null>(null)

  useEffect(() => {
    fetch('/api/hermes-config')
      .then((r) => r.json())
      .then((d: any) => {
        setConfig((d.config?.agent as Record<string, unknown>) || {})
      })
      .catch(() => {})
  }, [])

  const save = async (key: string, value: unknown) => {
    setMsg(null)
    try {
      await fetch('/api/hermes-config', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ config: { agent: { [key]: value } } }),
      })
      setConfig((prev) => ({ ...prev, [key]: value }))
      setMsg('Saved')
      setTimeout(() => setMsg(null), 2000)
    } catch {
      setMsg('Failed')
    }
  }

  return (
    <div className="space-y-4">
      <SectionHeader
        title="Agent Behavior"
        description="Execution limits and tool access."
      />
      {msg && (
        <div
          className={cn(
            'rounded-lg px-3 py-1.5 text-xs font-medium',
            msg === 'Saved'
              ? 'bg-green-500/15 text-green-400'
              : 'bg-red-500/15 text-red-400',
          )}
        >
          {msg}
        </div>
      )}
      <div className={SETTINGS_CARD_CLASS}>
        <Row
          label="Max turns"
          description="Maximum agent turns per request (1-100)"
        >
          <input
            type="number"
            min={1}
            max={100}
            value={Number(config.max_turns) || 50}
            onChange={(e) => save('max_turns', Number(e.target.value))}
            className="h-8 w-20 rounded-lg border border-primary-200 bg-primary-50 px-2 text-sm text-center text-primary-900 outline-none dark:border-neutral-700 dark:bg-neutral-900 dark:text-neutral-100"
          />
        </Row>
        <Row label="Gateway timeout" description="Seconds before timeout">
          <input
            type="number"
            min={10}
            max={600}
            value={Number(config.gateway_timeout) || 120}
            onChange={(e) => save('gateway_timeout', Number(e.target.value))}
            className="h-8 w-20 rounded-lg border border-primary-200 bg-primary-50 px-2 text-sm text-center text-primary-900 outline-none dark:border-neutral-700 dark:bg-neutral-900 dark:text-neutral-100"
          />
        </Row>
        <Row label="Tool enforcement" description="When agent must use tools">
          <select
            value={String(config.tool_use_enforcement || 'auto')}
            onChange={(e) => save('tool_use_enforcement', e.target.value)}
            className="h-8 rounded-lg border border-primary-200 bg-primary-50 px-2 text-sm text-primary-900 outline-none dark:border-neutral-700 dark:bg-neutral-900 dark:text-neutral-100"
          >
            <option value="auto">Auto</option>
            <option value="required">Required</option>
            <option value="none">None</option>
          </select>
        </Row>
      </div>
    </div>
  )
}

// ── Voice (TTS + STT) ──────────────────────────────────────────────────

function VoiceContent() {
  const [tts, setTts] = useState<Record<string, unknown>>({})
  const [stt, setStt] = useState<Record<string, unknown>>({})
  const [msg, setMsg] = useState<string | null>(null)

  useEffect(() => {
    fetch('/api/hermes-config')
      .then((r) => r.json())
      .then((d: any) => {
        setTts((d.config?.tts as Record<string, unknown>) || {})
        setStt((d.config?.stt as Record<string, unknown>) || {})
      })
      .catch(() => {})
  }, [])

  const saveTts = async (key: string, value: unknown) => {
    setMsg(null)
    try {
      await fetch('/api/hermes-config', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ config: { tts: { [key]: value } } }),
      })
      setTts((prev) => ({ ...prev, [key]: value }))
      setMsg('Saved')
      setTimeout(() => setMsg(null), 2000)
    } catch {
      setMsg('Failed')
    }
  }

  const saveStt = async (key: string, value: unknown) => {
    setMsg(null)
    try {
      await fetch('/api/hermes-config', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ config: { stt: { [key]: value } } }),
      })
      setStt((prev) => ({ ...prev, [key]: value }))
      setMsg('Saved')
      setTimeout(() => setMsg(null), 2000)
    } catch {
      setMsg('Failed')
    }
  }

  const ttsProvider = String(tts.provider || 'edge')
  const sttProvider = String(stt.provider || 'local')
  const sttGroq = (stt.groq as Record<string, unknown> | undefined) || {}

  return (
    <div className="space-y-4">
      <SectionHeader
        title="Voice"
        description="Text-to-speech and speech-to-text."
      />
      {msg && (
        <div
          className={cn(
            'rounded-lg px-3 py-1.5 text-xs font-medium',
            msg === 'Saved'
              ? 'bg-green-500/15 text-green-400'
              : 'bg-red-500/15 text-red-400',
          )}
        >
          {msg}
        </div>
      )}
      <div className={SETTINGS_CARD_CLASS}>
        <p className="mb-2 text-xs font-semibold uppercase tracking-wider text-primary-500">
          Text-to-Speech
        </p>
        <Row label="TTS Provider">
          <select
            value={ttsProvider}
            onChange={(e) => saveTts('provider', e.target.value)}
            className="h-8 rounded-lg border border-primary-200 bg-primary-50 px-2 text-sm text-primary-900 outline-none dark:border-neutral-700 dark:bg-neutral-900 dark:text-neutral-100"
          >
            <option value="edge">Edge TTS</option>
            <option value="elevenlabs">ElevenLabs</option>
            <option value="openai">OpenAI TTS</option>
            <option value="neutts">NeuTTS</option>
          </select>
        </Row>
        {ttsProvider === 'openai' && (
          <Row label="Voice">
            <select
              value={String(
                (tts.openai as Record<string, unknown>)?.voice || 'nova',
              )}
              onChange={(e) =>
                saveTts('openai', {
                  ...((tts.openai as Record<string, unknown>) || {}),
                  voice: e.target.value,
                })
              }
              className="h-8 rounded-lg border border-primary-200 bg-primary-50 px-2 text-sm text-primary-900 outline-none dark:border-neutral-700 dark:bg-neutral-900 dark:text-neutral-100"
            >
              {['alloy', 'echo', 'fable', 'onyx', 'nova', 'shimmer'].map(
                (v) => (
                  <option key={v} value={v}>
                    {v}
                  </option>
                ),
              )}
            </select>
          </Row>
        )}
      </div>
      <div className={SETTINGS_CARD_CLASS}>
        <p className="mb-2 text-xs font-semibold uppercase tracking-wider text-primary-500">
          Speech-to-Text
        </p>
        <Row label="Enable STT">
          <Switch
            checked={stt.enabled !== false}
            onCheckedChange={(c) => saveStt('enabled', c)}
          />
        </Row>
        <Row label="STT Provider">
          <select
            value={sttProvider}
            onChange={(e) => saveStt('provider', e.target.value)}
            className="h-8 rounded-lg border border-primary-200 bg-primary-50 px-2 text-sm text-primary-900 outline-none dark:border-neutral-700 dark:bg-neutral-900 dark:text-neutral-100"
          >
            {STT_PROVIDER_OPTIONS.map((provider) => (
              <option key={provider.value} value={provider.value}>
                {provider.label}
              </option>
            ))}
          </select>
        </Row>
        {sttProvider === 'groq' && (
          <>
            <Row label="Groq model">
              <select
                value={String(sttGroq.model || GROQ_STT_MODELS[0])}
                onChange={(e) =>
                  saveStt('groq', {
                    ...sttGroq,
                    model: e.target.value,
                  })
                }
                className="h-8 rounded-lg border border-primary-200 bg-primary-50 px-2 text-sm text-primary-900 outline-none dark:border-neutral-700 dark:bg-neutral-900 dark:text-neutral-100"
              >
                {GROQ_STT_MODELS.map((model) => (
                  <option key={model} value={model}>
                    {model}
                  </option>
                ))}
              </select>
            </Row>
            <Row
              label="Language"
              description="Optional BCP-47 code, e.g. en or en-US."
            >
              <Input
                value={String(stt.language || '')}
                onChange={(e) => saveStt('language', e.target.value)}
                placeholder="auto"
                className="h-8 w-40"
              />
            </Row>
          </>
        )}
      </div>
    </div>
  )
}

// ── Display ─────────────────────────────────────────────────────────────

function DisplayContent() {
  const [config, setConfig] = useState<Record<string, unknown>>({})
  const [msg, setMsg] = useState<string | null>(null)

  useEffect(() => {
    fetch('/api/hermes-config')
      .then((r) => r.json())
      .then((d: any) => {
        setConfig((d.config?.display as Record<string, unknown>) || {})
      })
      .catch(() => {})
  }, [])

  const save = async (key: string, value: unknown) => {
    setMsg(null)
    try {
      await fetch('/api/hermes-config', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ config: { display: { [key]: value } } }),
      })
      setConfig((prev) => ({ ...prev, [key]: value }))
      setMsg('Saved')
      setTimeout(() => setMsg(null), 2000)
    } catch {
      setMsg('Failed')
    }
  }

  return (
    <div className="space-y-4">
      <SectionHeader
        title="Display"
        description="Agent response style and output preferences."
      />
      {msg && (
        <div
          className={cn(
            'rounded-lg px-3 py-1.5 text-xs font-medium',
            msg === 'Saved'
              ? 'bg-green-500/15 text-green-400'
              : 'bg-red-500/15 text-red-400',
          )}
        >
          {msg}
        </div>
      )}
      <div className={SETTINGS_CARD_CLASS}>
        <Row label="Personality" description="Agent response style">
          <select
            value={String(config.personality || 'default')}
            onChange={(e) => save('personality', e.target.value)}
            className="h-8 rounded-lg border border-primary-200 bg-primary-50 px-2 text-sm text-primary-900 outline-none dark:border-neutral-700 dark:bg-neutral-900 dark:text-neutral-100"
          >
            <option value="default">Default</option>
            <option value="concise">Concise</option>
            <option value="verbose">Verbose</option>
            <option value="creative">Creative</option>
          </select>
        </Row>
        <Row label="Streaming" description="Stream responses in real-time">
          <Switch
            checked={config.streaming !== false}
            onCheckedChange={(c) => save('streaming', c)}
          />
        </Row>
        <Row
          label="Show reasoning"
          description="Display model thinking process"
        >
          <Switch
            checked={config.show_reasoning !== false}
            onCheckedChange={(c) => save('show_reasoning', c)}
          />
        </Row>
        <Row label="Show cost" description="Display token cost per response">
          <Switch
            checked={config.show_cost === true}
            onCheckedChange={(c) => save('show_cost', c)}
          />
        </Row>
        <Row label="Compact mode" description="Reduce spacing in responses">
          <Switch
            checked={config.compact === true}
            onCheckedChange={(c) => save('compact', c)}
          />
        </Row>
      </div>
    </div>
  )
}

function LanguageContent() {
  return (
    <div className="space-y-4">
      <SectionHeader
        title="Language"
        description="Choose the display language for the workspace UI."
      />
      <Row
        label="Interface Language"
        description="Translates navigation, labels, and buttons."
      >
        <select
          value={getLocale()}
          onChange={(e) => {
            setLocale(e.target.value as LocaleId)
            window.location.reload()
          }}
          className="h-9 w-full rounded-lg border border-primary-200 dark:border-neutral-700 bg-primary-50 dark:bg-neutral-800 px-3 text-sm text-primary-900 dark:text-neutral-100 outline-none md:max-w-xs"
        >
          {(Object.entries(LOCALE_LABELS) as Array<[LocaleId, string]>).map(
            ([id, label]) => (
              <option key={id} value={id}>
                {label}
              </option>
            ),
          )}
        </select>
      </Row>
    </div>
  )
}

// ── Agent context header ────────────────────────────────────────────────


function AgentInfo({ agent }: { agent: AgentWithStatus }) {
  return (
    <div className="mb-5 rounded-xl border border-primary-200 bg-primary-50/80 p-4 dark:border-primary-800 dark:bg-neutral-900">
      <div className="mb-3 flex items-center gap-3">
        <div className="flex size-10 items-center justify-center rounded-lg bg-primary-100 dark:bg-neutral-800">
          <span className="text-sm font-semibold text-primary-700 dark:text-neutral-200">
            {agent.name.slice(0, 2).toUpperCase()}
          </span>
        </div>
        <div className="min-w-0 flex-1">
          <h4 className="truncate text-sm font-semibold text-primary-900 dark:text-neutral-100">
            {agent.name}
          </h4>
          <p className="text-xs text-primary-500 dark:text-neutral-400">
            {agentRuntimeLabel(agent.runtime)}
          </p>
        </div>
      </div>
      <dl className="space-y-1.5 text-xs">
        <div className="flex justify-between gap-4">
          <dt className="text-primary-500 dark:text-neutral-400">Agent ID</dt>
          <dd className="font-mono text-primary-900 dark:text-neutral-200">
            {agent.agentId}
          </dd>
        </div>
        {agent.runtimeConfig.profile ? (
          <div className="flex justify-between gap-4">
            <dt className="text-primary-500 dark:text-neutral-400">Profile</dt>
            <dd className="font-mono text-primary-900 dark:text-neutral-200">
              {agent.runtimeConfig.profile}
            </dd>
          </div>
        ) : null}
        {agent.runtimeConfig.command ? (
          <div className="flex justify-between gap-4">
            <dt className="text-primary-500 dark:text-neutral-400">Command</dt>
            <dd className="font-mono text-primary-900 dark:text-neutral-200">
              {agent.runtimeConfig.command}
            </dd>
          </div>
        ) : null}
        {agent.runtimeConfig.capabilities.length > 0 ? (
          <div className="flex justify-between gap-4">
            <dt className="text-primary-500 dark:text-neutral-400">Capabilities</dt>
            <dd className="text-right text-primary-900 dark:text-neutral-200">
              {agent.runtimeConfig.capabilities.join(', ')}
            </dd>
          </div>
        ) : null}
      </dl>
    </div>
  )
}

// ── Main Dialog ─────────────────────────────────────────────────────────

function DefaultHermesContent() {
  return <HermesContent />
}

const CONTENT_MAP: Record<SectionId, () => React.JSX.Element> = {
  profile: ProfileContent,
  claude: DefaultHermesContent,
  usage_pricing: UsagePricingPanel,
  agent: AgentBehaviorContent,
  voice: VoiceContent,
  display: DisplayContent,
  appearance: AppearanceContent,
  chat: ChatContent,
  notifications: NotificationsContent,
  language: LanguageContent,
}

type SettingsDialogProps = {
  open: boolean
  onOpenChange: (open: boolean) => void
  initialSection?: SectionId
  /** When set, the dialog scopes settings to this agent and surfaces its runtime-specific config. */
  agentId?: string
}

export function SettingsDialog({
  open,
  onOpenChange,
  initialSection = 'claude',
  agentId,
}: SettingsDialogProps) {
  const [active, setActive] = useState<SectionId>(initialSection)
  const [mobileView, setMobileView] = useState<'nav' | 'content'>('nav')
  const [agent, setAgent] = useState<AgentWithStatus | null>(null)
  const [agentLoading, setAgentLoading] = useState(false)

  useEffect(() => {
    if (!open || !agentId) {
      setAgent(null)
      return
    }
    setAgentLoading(true)
    fetchAgents()
      .then((data) => {
        const found = data.agents.find((a) => a.agentId === agentId)
        if (found) setAgent(found)
      })
      .catch(() => {})
      .finally(() => setAgentLoading(false))
  }, [open, agentId])

  useEffect(() => {
    if (open) {
      setActive(initialSection)
      setMobileView('nav')
    }
  }, [initialSection, open])

  function handleSectionSelect(sectionId: SectionId) {
    setActive(sectionId)
    setMobileView('content')
  }

  const ActiveContent = CONTENT_MAP[active]

  function renderContent() {
    if (active !== 'claude' || !agentId) {
      return <ActiveContent />
    }
    if (agentLoading) {
      return (
        <div className="h-20 animate-pulse rounded-lg bg-primary-100/70 dark:bg-neutral-800" />
      )
    }
    if (!agent) {
      return (
        <div className="rounded-lg bg-red-500/15 px-3 py-2 text-sm text-red-400">
          Agent not found
        </div>
      )
    }
    if (agent.runtime === 'hermes') {
      return <HermesContent profileName={agent.runtimeConfig.profile} />
    }
    if (agent.runtime === 'codex') {
      return <CodexSettingsPanel agentId={agent.agentId} />
    }
    // Generic managed-runtime settings for every other non-hermes runtime
    // (claude-code, opencode, cursor, kimi, and future managed backends).
    return <ClaudeCodeSettingsPanel agentId={agent.agentId} />
  }

  return (
    <DialogRoot open={open} onOpenChange={onOpenChange}>
      <DialogContent className="inset-0 h-full w-full max-w-none translate-x-0 translate-y-0 overflow-hidden rounded-none border-0 p-0 shadow-xl md:inset-auto md:left-1/2 md:top-1/2 md:h-[min(88dvh,740px)] md:min-h-[520px] md:w-full md:max-w-3xl md:-translate-x-1/2 md:-translate-y-1/2 md:rounded-2xl md:border md:border-primary-200 bg-[var(--theme-bg)]">
        <div className="flex h-full min-h-0 flex-col">
          <div className="flex items-center justify-between border-b border-primary-200 bg-primary-50/80 px-4 py-4 md:rounded-t-2xl md:px-5">
            <div>
              <DialogTitle className="text-base font-semibold text-primary-900 dark:text-neutral-100">
                {agent ? `${agent.name} Settings` : 'Settings'}
              </DialogTitle>
              <DialogDescription className="sr-only">
                Configure Agorax
              </DialogDescription>
            </div>
            <DialogClose
              render={
                <Button
                  size="icon-sm"
                  variant="ghost"
                  className="rounded-full text-primary-500 hover:bg-primary-100 dark:text-neutral-400 dark:hover:bg-neutral-800"
                  aria-label="Close"
                >
                  <HugeiconsIcon
                    icon={Cancel01Icon}
                    size={18}
                    strokeWidth={1.5}
                  />
                </Button>
              }
            />
          </div>

          <SettingsErrorBoundary>
            <div className="flex min-h-0 flex-1 flex-col md:flex-row">
              <aside
                className={cn(
                  'w-full bg-primary-50/60 p-2 md:w-44 md:shrink-0 md:border-r md:border-primary-200',
                  mobileView === 'content' && 'hidden md:block',
                )}
              >
                <nav className="space-y-1">
                  {SECTIONS.map((s) => (
                    <button
                      key={s.id}
                      type="button"
                      onClick={() => handleSectionSelect(s.id)}
                      className={cn(
                        'flex w-full items-center gap-2.5 rounded-lg px-3 py-2 text-left text-sm text-primary-600 transition-colors hover:bg-primary-100',
                        active === s.id &&
                          'bg-accent-50 font-medium text-accent-700',
                      )}
                    >
                      <HugeiconsIcon
                        icon={s.icon}
                        size={16}
                        strokeWidth={1.5}
                      />
                      {s.label}
                    </button>
                  ))}
                </nav>
              </aside>
              <div
                className={cn(
                  'min-w-0 flex-1 overflow-y-auto p-4 pb-[calc(env(safe-area-inset-bottom)+1rem)] md:p-5 md:pb-5',
                  mobileView === 'nav' && 'hidden md:block',
                )}
              >
                <div className="mb-3 md:hidden">
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    onClick={() => setMobileView('nav')}
                    className="h-8 gap-1.5 rounded-lg px-2 text-primary-600 hover:bg-primary-100"
                  >
                    <HugeiconsIcon
                      icon={ArrowLeft01Icon}
                      size={16}
                      strokeWidth={1.5}
                    />
                    Back
                  </Button>
                </div>
                {agent && <AgentInfo agent={agent} />}
                {renderContent()}
              </div>
            </div>
          </SettingsErrorBoundary>

          <div className="sticky bottom-0 z-10 border-t border-primary-200 bg-primary-50/60 px-4 py-3 text-xs text-primary-500 dark:text-neutral-400 md:rounded-b-2xl md:px-5">
            Most changes save automatically; the default model commits only when
            you click Set as default.{' '}
            <a
              href="/settings"
              className="ml-2 font-medium underline underline-offset-2 hover:text-primary-700 dark:hover:text-neutral-200"
            >
              All settings →
            </a>
          </div>
        </div>
      </DialogContent>
    </DialogRoot>
  )
}
