import { Given, Then, When } from '@cucumber/cucumber'
import { expect } from '@playwright/test'

import { ensureChatComposerReady } from '../../helpers/chat-page'
import { installChatMocks } from '../mocks/chat'
import { installPageMocks } from '../mocks/pages'
import type { AgoraxWorld } from '../support/world'

Given('工作区使用隔离页面数据', async function (this: AgoraxWorld) {
  this.chatMock = await installChatMocks(this.page, this.sessionId)
  await installPageMocks(this.page)
})

Given('工作区使用未绑定 Skill 的隔离数据', async function (this: AgoraxWorld) {
  this.chatMock = await installChatMocks(this.page, this.sessionId)
  await installPageMocks(this.page, { unboundSkills: true })
})

When(
  '用户打开工作区页面 {string}',
  async function (this: AgoraxWorld, pathname: string) {
    this.operations.push(`navigate: ${pathname}`)
    await this.page.goto(pathname)
  },
)

Then(
  '工作区主标题为 {string}',
  async function (this: AgoraxWorld, heading: string) {
    await expect(
      this.page
        .getByRole('main')
        .getByRole('heading', { name: heading, exact: true, level: 1 }),
    ).toBeVisible({ timeout: 15_000 })
  },
)

When(
  '用户在页面中点击 {string}',
  async function (this: AgoraxWorld, name: string) {
    await this.page
      .getByRole('main')
      .getByRole('button', { name, exact: true })
      .click()
  },
)

Then(
  '页面路由应为 {string}',
  async function (this: AgoraxWorld, pathname: string) {
    await expect(this.page).toHaveURL(
      new RegExp(
        `${pathname.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?:\\?.*)?$`,
      ),
    )
  },
)

Then('聊天输入框可用', async function (this: AgoraxWorld) {
  const composer = await ensureChatComposerReady(this.page)
  await expect(composer).toBeEnabled()
})

Then(
  '页面业务内容包含 {string}',
  async function (this: AgoraxWorld, text: string) {
    await expect(
      this.page.getByRole('main').getByText(text, { exact: true }),
    ).toBeVisible({ timeout: 15_000 })
  },
)

Then(
  '页面业务内容不包含 {string}',
  async function (this: AgoraxWorld, text: string) {
    await expect(
      this.page.getByRole('main').getByText(text, { exact: true }),
    ).toHaveCount(0)
  },
)

When(
  '用户在搜索框 {string} 输入 {string}',
  async function (this: AgoraxWorld, placeholder: string, value: string) {
    await this.page.getByPlaceholder(placeholder, { exact: true }).fill(value)
  },
)

When(
  '用户选择工作区文件 {string}',
  async function (this: AgoraxWorld, filename: string) {
    await this.page.getByText(filename, { exact: true }).click()
  },
)

When(
  '用户切换页面标签 {string}',
  async function (this: AgoraxWorld, name: string) {
    await this.page
      .getByRole('main')
      .getByRole('tab', { name, exact: true })
      .click()
  },
)

When(
  '用户选择 {string} 下的 {string}',
  async function (this: AgoraxWorld, label: string, value: string) {
    await this.page
      .getByRole('combobox', { name: new RegExp(`^${label}(?:\\s|$)`) })
      .selectOption(value)
  },
)

Then(
  '页面上有 {string} 按钮',
  async function (this: AgoraxWorld, name: string) {
    await expect(
      this.page.getByRole('button', { name, exact: true }),
    ).toBeVisible({ timeout: 15_000 })
  },
)

When('用户新增终端标签页', async function (this: AgoraxWorld) {
  this.previousItemCount = await this.page.getByRole('tab').count()
  await this.page
    .getByRole('button', { name: 'New terminal tab', exact: true })
    .click()
})

Then('终端新增一个标签页', async function (this: AgoraxWorld) {
  await expect(this.page.getByRole('tab')).toHaveCount(
    this.previousItemCount + 1,
  )
})

When('用户重新加载工作区页面', async function (this: AgoraxWorld) {
  await this.page.reload()
})

Then('{string} 开关为关闭', async function (this: AgoraxWorld, name: string) {
  await expect(
    this.page.getByRole('switch', { name, exact: true }),
  ).not.toBeChecked()
})

Then('{string} 开关为开启', async function (this: AgoraxWorld, name: string) {
  await expect(
    this.page.getByRole('switch', { name, exact: true }),
  ).toBeChecked()
})

When(
  '用户切换 {string} 开关',
  async function (this: AgoraxWorld, name: string) {
    await this.page.getByRole('switch', { name, exact: true }).click()
  },
)

When(
  '用户打开页面创建表单 {string}',
  async function (this: AgoraxWorld, name: string) {
    await this.page
      .getByRole('main')
      .locator('header')
      .getByRole('button', { name, exact: true })
      .click()
  },
)

Then(
  '页面显示表单标题 {string}',
  async function (this: AgoraxWorld, title: string) {
    await expect(
      this.page.getByRole('heading').filter({ hasText: title }),
    ).toBeVisible()
  },
)

When('用户取消表单 {string}', async function (this: AgoraxWorld, name: string) {
  if (name === 'Escape') {
    await this.page.keyboard.press('Escape')
    return
  }
  await this.page.getByRole('button', { name, exact: true }).click()
})

Then(
  '页面不再显示表单标题 {string}',
  async function (this: AgoraxWorld, title: string) {
    await expect(
      this.page.getByRole('heading').filter({ hasText: title }),
    ).toHaveCount(0)
  },
)

Then('页面生成按钮不可用', async function (this: AgoraxWorld) {
  await expect(
    this.page.getByRole('button', { name: /Create Full Page \+ API/ }),
  ).toBeDisabled()
})

When(
  '用户打开列表条目 {string}',
  async function (this: AgoraxWorld, name: string) {
    await this.page.getByRole('main').getByText(name, { exact: true }).click()
  },
)

Then(
  '详情页标题为 {string}',
  async function (this: AgoraxWorld, title: string) {
    await expect(
      this.page
        .getByRole('main')
        .locator('header')
        .getByRole('heading', { name: title, exact: true, level: 1 }),
    ).toBeVisible()
  },
)

When(
  '用户确认 Agent {string} 的 MCP 解除',
  async function (this: AgoraxWorld, agentId: string) {
    if (agentId === 'default')
      await this.page
        .getByRole('button', { name: 'Confirm Remove', exact: true })
        .click()
  },
)

When(
  '用户选择 Skill 目标 {string} runtime {string}',
  async function (this: AgoraxWorld, name: string, runtime: string) {
    const dialog = this.page.getByRole('dialog')
    if (runtime !== 'hermes')
      await dialog.getByRole('button', { name: /^Managed/ }).click()
    await dialog.getByRole('checkbox', { name: new RegExp(name) }).check()
  },
)

When('用户确认添加 Skill', async function (this: AgoraxWorld) {
  await this.page
    .getByRole('dialog')
    .getByRole('button', { name: '添加 (1)', exact: true })
    .click()
  await expect(this.page.getByRole('dialog')).toHaveCount(0)
})
