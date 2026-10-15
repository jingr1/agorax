/**
 * Lightweight i18n — UI string translations for Agorax.
 * Supported locales: English and Simplified Chinese.
 */

export type LocaleId = 'en' | 'zh'

const EN = {
  // Nav
  'nav.dashboard': 'Dashboard',
  'nav.chat': 'Chat',
  'nav.files': 'Files',
  'nav.terminal': 'Terminal',
  'nav.jobs': 'Jobs',
  'nav.tasks': 'Tasks',
  'nav.missions': 'Missions',
  'nav.groups': 'Groups',
  'nav.agents': 'Agents',
  'nav.swarm': 'Swarm',
  'nav.mcp': 'MCP',
  'nav.echoStudio': 'Echo Studio',
  'nav.memory': 'Memory',
  'nav.skills': 'Skills',
  'nav.profiles': 'Profiles',
  'nav.settings': 'Settings',
  // Skills
  'skills.installed': 'Installed',
  'skills.marketplace': 'Marketplace',
  'skills.search': 'Search by name, tags, or description',
  'skills.noResults': 'No skills found',
  // Profiles
  'profiles.profiles': 'Profiles',
  'profiles.monitoring': 'Monitoring',
  // Tasks
  'tasks.title': 'Tasks',
  'tasks.newTask': 'New Task',
  'tasks.backlog': 'Backlog',
  'tasks.todo': 'Todo',
  'tasks.inProgress': 'In Progress',
  'tasks.review': 'Review',
  'tasks.done': 'Done',
  // Jobs
  'jobs.title': 'Jobs',
  'jobs.newJob': 'New Job',
  // Settings
  'settings.title': 'Settings',
  'settings.language': 'Language',
  'settings.languageDesc': 'Choose the display language for the workspace UI.',
  // Common
  'common.save': 'Save',
  'common.cancel': 'Cancel',
  'common.delete': 'Delete',
  'common.search': 'Search',
  'common.loading': 'Loading...',
  'common.error': 'Error',
  'common.noData': 'No data',
} as const

export type TranslationKey = keyof typeof EN
type LocaleTranslations = Record<TranslationKey, string>

const ZH: LocaleTranslations = {
  'nav.dashboard': '仪表板',
  'nav.chat': '聊天',
  'nav.files': '文件',
  'nav.terminal': '终端',
  'nav.jobs': '作业',
  'nav.tasks': '任务',
  'nav.missions': '任务',
  'nav.groups': '群聊',
  'nav.agents': '智能体',
  'nav.swarm': '集群',
  'nav.mcp': 'MCP',
  'nav.echoStudio': 'Echo Studio',
  'nav.memory': '记忆',
  'nav.skills': '技能',
  'nav.profiles': '配置文件',
  'nav.settings': '设置',
  'skills.installed': '已安装',
  'skills.marketplace': '市场',
  'skills.search': '按名称、标签或描述搜索',
  'skills.noResults': '未找到技能',
  'profiles.profiles': '配置文件',
  'profiles.monitoring': '监控',
  'tasks.title': '任务',
  'tasks.newTask': '新建任务',
  'tasks.backlog': '待办池',
  'tasks.todo': '待处理',
  'tasks.inProgress': '进行中',
  'tasks.review': '审核',
  'tasks.done': '完成',
  'jobs.title': '作业',
  'jobs.newJob': '新建作业',
  'settings.title': '设置',
  'settings.language': '语言',
  'settings.languageDesc': '选择工作区界面显示语言。',
  'common.save': '保存',
  'common.cancel': '取消',
  'common.delete': '删除',
  'common.search': '搜索',
  'common.loading': '加载中...',
  'common.error': '错误',
  'common.noData': '暂无数据',
}

const LOCALES: Record<LocaleId, LocaleTranslations> = {
  en: EN,
  zh: ZH,
}

export const LOCALE_LABELS: Record<LocaleId, string> = {
  en: 'English',
  zh: '中文（简体）',
}

const STORAGE_KEY = 'agorax-locale'
const LEGACY_STORAGE_KEY = 'hermes-workspace-locale'

export function getLocale(): LocaleId {
  if (typeof window === 'undefined') return 'en'
  const stored =
    localStorage.getItem(STORAGE_KEY) ??
    localStorage.getItem(LEGACY_STORAGE_KEY)
  if (stored && stored in LOCALES) return stored as LocaleId
  const full = navigator.language
  if (full in LOCALES) return full as LocaleId
  const lang = full.split('-')[0]
  if (lang in LOCALES) return lang as LocaleId
  return 'en'
}

export function setLocale(id: LocaleId): void {
  localStorage.setItem(STORAGE_KEY, id)
  window.dispatchEvent(new CustomEvent('locale-change', { detail: id }))
}

export function t(key: TranslationKey): string {
  const locale = getLocale()
  return LOCALES[locale]?.[key] ?? LOCALES.en[key] ?? key
}
