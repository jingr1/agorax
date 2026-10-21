import type { ComponentProps } from 'react'
import type { HugeiconsIcon } from '@hugeicons/react'
import {
  BrainIcon,
  Chat01Icon,
  Clock01Icon,
  CommandLineIcon,
  DashboardSquare01Icon,
  File01Icon,
  McpServerIcon,
  MessageMultiple02Icon,
  PuzzleIcon,
  Rocket01Icon,
  Search01Icon,
  Settings01Icon,
  Target02Icon,
  UserGroupIcon,
  UserMultipleIcon,
} from '@hugeicons/core-free-icons'

export type NavContainer = 'sidebar' | 'hamburger' | 'tabbar' | 'command'

export type NavItem = {
  id: string
  label: string
  icon: ComponentProps<typeof HugeiconsIcon>['icon']
  to: string
  keywords: string
  match: (pathname: string) => boolean
  containers: Array<NavContainer>
  featureFlag?: 'echoStudio'
}

/**
 * Single source of truth for global navigation.
 *
 * Each item declares which surfaces it appears in so the desktop sidebar,
 * mobile hamburger, mobile tab bar, and command palette stay in sync.
 */
export const NAV_ITEMS: Array<NavItem> = [
  {
    id: 'dashboard',
    label: 'Dashboard',
    icon: DashboardSquare01Icon,
    to: '/dashboard',
    keywords: 'dashboard home start',
    match: (p) => p === '/dashboard',
    containers: ['sidebar', 'hamburger', 'tabbar', 'command'],
  },
  {
    id: 'chat',
    label: 'Chat',
    icon: Chat01Icon,
    to: '/chat',
    keywords: 'chat conversation messages home',
    match: (p) => p.startsWith('/chat') || p === '/new' || p === '/',
    containers: ['sidebar', 'hamburger', 'tabbar', 'command'],
  },
  {
    id: 'files',
    label: 'Files',
    icon: File01Icon,
    to: '/files',
    keywords: 'files workspace editor browser',
    match: (p) => p.startsWith('/files'),
    containers: ['sidebar', 'hamburger', 'tabbar', 'command'],
  },
  {
    id: 'terminal',
    label: 'Terminal',
    icon: CommandLineIcon,
    to: '/terminal',
    keywords: 'terminal console shell command line',
    match: (p) => p.startsWith('/terminal'),
    containers: ['sidebar', 'hamburger', 'tabbar', 'command'],
  },
  {
    id: 'jobs',
    label: 'Jobs',
    icon: Clock01Icon,
    to: '/jobs',
    keywords: 'jobs tasks queue background',
    match: (p) => p.startsWith('/jobs'),
    containers: ['sidebar', 'hamburger', 'tabbar', 'command'],
  },
  {
    id: 'missions',
    label: 'Missions',
    icon: Target02Icon,
    to: '/missions',
    keywords: 'missions mission control tasks operations',
    match: (p) =>
      p.startsWith('/missions') || p.startsWith('/mission-control'),
    containers: ['sidebar', 'hamburger', 'tabbar', 'command'],
  },
  {
    id: 'groups',
    label: 'Groups',
    icon: MessageMultiple02Icon,
    to: '/group-chat',
    keywords: 'groups rooms group chat collaboration',
    match: (p) => p.startsWith('/group-chat'),
    containers: ['sidebar', 'hamburger', 'tabbar', 'command'],
  },
  {
    id: 'agents',
    label: 'Agents',
    icon: UserMultipleIcon,
    to: '/agents',
    keywords: 'agents profiles workers runtime registry',
    match: (p) =>
      p.startsWith('/agents') ||
      p.startsWith('/operations') ||
      p.startsWith('/profiles'),
    containers: ['sidebar', 'hamburger', 'tabbar', 'command'],
  },
  {
    id: 'swarm',
    label: 'Swarm',
    icon: UserGroupIcon,
    to: '/swarm',
    keywords: 'swarm orchestration langgraph',
    match: (p) => p === '/swarm' || p.startsWith('/swarm2'),
    containers: ['sidebar', 'hamburger', 'tabbar', 'command'],
  },
  {
    id: 'echo-studio',
    label: 'Echo Studio',
    icon: Rocket01Icon,
    to: '/echo-studio',
    keywords: 'echo studio experiments playground',
    match: (p) => p.startsWith('/echo-studio'),
    containers: ['sidebar', 'hamburger', 'tabbar', 'command'],
    featureFlag: 'echoStudio',
  },
  {
    id: 'memory',
    label: 'Memory',
    icon: BrainIcon,
    to: '/memory',
    keywords: 'memory knowledge durable notes',
    match: (p) => p.startsWith('/memory'),
    containers: ['sidebar', 'hamburger', 'tabbar', 'command'],
  },
  {
    id: 'skills',
    label: 'Skills',
    icon: PuzzleIcon,
    to: '/skills',
    keywords: 'skills install tools capabilities',
    match: (p) => p.startsWith('/skills'),
    containers: ['sidebar', 'hamburger', 'tabbar', 'command'],
  },
  {
    id: 'mcp',
    label: 'MCP',
    icon: McpServerIcon,
    to: '/mcp',
    keywords: 'mcp servers model context protocol presets',
    match: (p) => p.startsWith('/mcp'),
    containers: ['sidebar', 'hamburger', 'tabbar', 'command'],
  },
  {
    id: 'settings',
    label: 'Settings',
    icon: Settings01Icon,
    to: '/settings',
    keywords: 'settings preferences configuration',
    match: (p) => p.startsWith('/settings'),
    containers: ['hamburger', 'tabbar', 'command'],
  },
  {
    id: 'search',
    label: 'Search',
    icon: Search01Icon,
    to: '#',
    keywords: 'search find global',
    match: () => false,
    containers: ['hamburger'],
  },
]
