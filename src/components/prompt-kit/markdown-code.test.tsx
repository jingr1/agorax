import { beforeAll, describe, expect, it, vi } from 'vitest'
import React from 'react'
import { createRoot } from 'react-dom/client'

vi.mock('@/components/ui/button', () => ({
  Button: ({
    children,
    onClick,
    disabled,
    ...props
  }: {
    children?: React.ReactNode
    onClick?: () => void
    disabled?: boolean
    [k: string]: unknown
  }) => React.createElement('button', { onClick, disabled, ...props }, children),
}))

import { Markdown } from './markdown'

beforeAll(() => {
  // React 19's createRoot in jsdom needs this flag for act() to be accepted.
  globalThis.IS_REACT_ACT_ENVIRONMENT = true
})

async function renderToHtml(element: React.ReactElement) {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)
  await React.act(async () => {
    root.render(element)
  })
  const html = container.innerHTML
  await React.act(async () => {
    root.unmount()
  })
  document.body.removeChild(container)
  return html
}

describe('Markdown fenced code blocks', () => {
  it('renders bash fences with language class from the code component', async () => {
    const html = await renderToHtml(
      <Markdown>{'```bash\ndocker exec -it x\n```'}</Markdown>,
    )
    expect(html).toContain('Bash')
    expect(html).not.toContain('Plain Text')
  })

  it('renders a one-line shell command as a wrapping code block', async () => {
    const command =
      "bash sudo tee /etc/udev/rules.d/99-allspark-npu.rules <<'EOF' KERNEL==\"ad_npu_procfs_c1\", MODE=\"0666\""
    const html = await renderToHtml(
      <Markdown>{`先执行\n\n\`${command}\`\n`}</Markdown>,
    )
    expect(html).toContain('code-block')
    expect(html).toContain('Bash')
    expect(html).toContain('0666')
    expect(html).not.toContain('inline-code')
  })

  it('keeps short inline tokens as chips', async () => {
    const html = await renderToHtml(
      <Markdown>{'设备 `/dev/ad_npu_procfs_c1` 的权限'}</Markdown>,
    )
    expect(html).toContain('inline-code')
    expect(html).toContain('/dev/ad_npu_procfs_c1')
    expect(html).not.toContain('code-block')
  })

  it('renders a one-line unlabeled fence as a code block', async () => {
    const html = await renderToHtml(
      <Markdown>{['```', 'echo hi', '```'].join('\n')}</Markdown>,
    )
    expect(html).toContain('code-block')
    expect(html).toContain('echo hi')
    expect(html).not.toContain('inline-code')
  })

  it('infers bash for unlabeled CLI usage fences', async () => {
    const html = await renderToHtml(
      <Markdown>
        {['```', 'Usage: acompile [options]', '  --onnx=<path>', '```'].join(
          '\n',
        )}
      </Markdown>,
    )
    expect(html).toContain('Bash')
  })
})
