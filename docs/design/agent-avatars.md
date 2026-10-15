# Agent Identity Avatars

> 智能体头像：按 provider 选底图，统一圆框；同 provider 多智能体时叠加双字母微章。

## 规则

1. **形状**：UI 一律 `rounded-full` 圆框裁剪。
2. **底图**：按归一化后的 `runtime` / provider 取 `public/agent-avatars/` 下对应资产；未知 provider 走 Agorax 默认图。
3. **微章**：同一 provider 在 roster 中 **多于 1 个** 智能体时，在圆框右下角叠加该智能体名称的 **两个字母**（多词取前两词首字母，单词取前两字）。
4. **单 agent provider**：只显示 provider 圆图，无字母微章。

## 投影入口

```ts
import { projectAgentIdentityAvatar } from '@/lib/agent-avatar'
import { AgentIdentityAvatar } from '@/components/avatars'

const presentation = projectAgentIdentityAvatar({
  name: 'Researcher',
  runtime: 'hermes',
  providerSiblingCount: 6, // → initials "RE"
})
```

组件：`AgentIdentityAvatar`（`src/components/avatars/agent-identity-avatar.tsx`）。

## Provider → 资产

| runtime（归一化） | 资产 |
| --- | --- |
| hermes | hermes-rounded.png（多角色靠双字母区分） |
| claude-code | claude-rounded.png |
| codex | codex-rounded.png |
| cursor | cursor-rounded.png |
| opencode | opencode-rounded.png |
| openclaw | openclaw-rounded.png |
| kimi / kimi-code | kimi-rounded.png |
| deepseek-harness | deepseek-rounded.png |
| agorax / fallback（未知） | agorax-rounded.png |
