import { useState } from 'react'
import { HugeiconsIcon } from '@hugeicons/react'
import {
  Add01Icon,
  Delete02Icon,
  Download01Icon,
  File01Icon,
  Folder01Icon,
} from '@hugeicons/core-free-icons'
import type { PlatformSkillFile } from '@/server/platform-skills/types'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Tabs, TabsList, TabsTab } from '@/components/ui/tabs'
import { Markdown } from '@/components/prompt-kit/markdown'

type Props = {
  content: string
  files: Array<PlatformSkillFile>
  editing: boolean
  onContentChange: (content: string) => void
  onFilesChange: (files: Array<PlatformSkillFile>) => void
}

export function SkillFilesPanel({
  content,
  files,
  editing,
  onContentChange,
  onFilesChange,
}: Props) {
  const [selected, setSelected] = useState('SKILL.md')
  const [mode, setMode] = useState('preview')
  const [newPath, setNewPath] = useState('')
  const [error, setError] = useState('')
  const allFiles: Array<PlatformSkillFile> = [
    { path: 'SKILL.md', content },
    ...files,
  ]
  const file = allFiles.find((entry) => entry.path === selected) ?? allFiles[0]
  const binary = file.encoding === 'base64'
  const folders = (prefix: string) => {
    const children = [
      ...new Set(
        allFiles
          .filter((entry) => entry.path.startsWith(prefix))
          .map((entry) => entry.path.slice(prefix.length).split('/')[0]),
      ),
    ].sort()
    return children.map((name) => {
      const full = `${prefix}${name}`
      const leaf = allFiles.find((entry) => entry.path === full)
      if (!leaf)
        return (
          <details key={full} open className="min-w-0">
            <summary className="cursor-pointer break-all rounded px-2 py-1.5 text-xs text-primary-600">
              <HugeiconsIcon
                icon={Folder01Icon}
                size={14}
                className="mr-1 inline"
              />
              {name}/
            </summary>
            <div className="ml-3 border-l border-primary-200 pl-1">
              {folders(`${full}/`)}
            </div>
          </details>
        )
      return (
        <button
          key={full}
          type="button"
          title={full}
          aria-current={file.path === full ? 'true' : undefined}
          onClick={() => setSelected(full)}
          className={`flex w-full min-w-0 items-start gap-1.5 rounded px-2 py-1.5 text-left text-xs hover:bg-primary-100 ${file.path === full ? 'bg-primary-100 font-medium text-ink' : 'text-primary-500'}`}
        >
          <HugeiconsIcon icon={File01Icon} size={14} className="shrink-0" />
          <span className="break-all">{name}</span>
        </button>
      )
    })
  }
  const addFile = () => {
    const relative = newPath.trim().replace(/\\/g, '/')
    if (
      !relative ||
      relative.startsWith('/') ||
      relative
        .split('/')
        .some(
          (part) =>
            !part ||
            part === '.' ||
            part === '..' ||
            /[<>:"|?*]/.test(part) ||
            [...part].some((character) => character.charCodeAt(0) < 32),
        ) ||
      allFiles.some(
        (entry) => entry.path.toLowerCase() === relative.toLowerCase(),
      )
    ) {
      setError('文件路径无效或已存在')
      return
    }
    onFilesChange([...files, { path: relative, content: '' }])
    setSelected(relative)
    setNewPath('')
    setError('')
  }

  return (
    <section aria-label="技能文件" className="min-w-0 space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-sm font-medium">文件 ({allFiles.length})</h2>
        <Tabs value={mode} onValueChange={(value) => setMode(String(value))}>
          <TabsList>
            <TabsTab value="preview">预览</TabsTab>
            <TabsTab value="source">源码</TabsTab>
          </TabsList>
        </Tabs>
      </div>
      {editing && (
        <div className="space-y-1">
          <div className="flex min-w-0 gap-2">
            <Input
              value={newPath}
              onChange={(event) => setNewPath(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter') {
                  event.preventDefault()
                  addFile()
                }
              }}
              aria-label="新文件路径"
              placeholder="references/guide.md"
              className="min-w-0 flex-1"
            />
            <Button type="button" size="sm" variant="outline" onClick={addFile}>
              <HugeiconsIcon icon={Add01Icon} size={14} />
              添加文件
            </Button>
          </div>
          {error && (
            <p role="alert" className="text-xs text-danger">
              {error}
            </p>
          )}
        </div>
      )}
      <div className="grid min-w-0 grid-cols-1 overflow-hidden rounded-lg border border-primary-200 md:grid-cols-[220px_minmax(0,1fr)]">
        <nav
          aria-label="技能文件目录"
          className="max-h-56 min-w-0 overflow-auto border-b border-primary-200 p-2 md:max-h-[38rem] md:border-r md:border-b-0"
        >
          {folders('')}
        </nav>
        <div className="min-w-0">
          <div className="flex min-h-11 flex-wrap items-center justify-between gap-2 border-b border-primary-200 px-3 py-2">
            <span className="min-w-0 break-all font-mono text-xs">
              {file.path}
            </span>
            <div className="flex shrink-0 gap-2">
              <a
                aria-label={`下载 ${file.path}`}
                title="下载文件"
                download={file.path.split('/').pop()}
                href={
                  binary
                    ? `data:application/octet-stream;base64,${file.content}`
                    : `data:text/plain;charset=utf-8,${encodeURIComponent(file.content)}`
                }
                className="rounded p-1.5 text-primary-600 hover:bg-primary-100"
              >
                <HugeiconsIcon icon={Download01Icon} size={16} />
              </a>
              {editing && file.path !== 'SKILL.md' && (
                <Button
                  type="button"
                  size="sm"
                  variant="ghost"
                  title="移除文件"
                  aria-label={`移除 ${file.path}`}
                  onClick={() => {
                    onFilesChange(
                      files.filter((entry) => entry.path !== file.path),
                    )
                    setSelected('SKILL.md')
                  }}
                >
                  <HugeiconsIcon icon={Delete02Icon} size={14} />
                </Button>
              )}
            </div>
          </div>
          {binary ? (
            <div className="min-h-64 p-4 text-sm text-primary-500">
              二进制附件
            </div>
          ) : editing || mode === 'source' || !/\.md$/i.test(file.path) ? (
            <textarea
              aria-label={`文件内容 ${file.path}`}
              value={file.content}
              readOnly={!editing}
              spellCheck={false}
              onChange={(event) =>
                file.path === 'SKILL.md'
                  ? onContentChange(event.target.value)
                  : onFilesChange(
                      files.map((entry) =>
                        entry.path === file.path
                          ? { ...entry, content: event.target.value }
                          : entry,
                      ),
                    )
              }
              className="block min-h-80 w-full resize-y bg-transparent p-4 font-mono text-xs leading-relaxed outline-none focus:ring-2 focus:ring-primary-400"
            />
          ) : (
            <div className="min-h-80 overflow-x-auto p-4 text-sm">
              <Markdown>{file.content || '_空_'}</Markdown>
            </div>
          )}
        </div>
      </div>
    </section>
  )
}
