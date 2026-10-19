# Agorax 头像清单

> 项目内所有头像资产、代码入口、特点与替换方式。Chat / Agents / Groups 主路径用 **Agent Identity**；其余系统勿混用。

---

## 1. Agent Identity（主路径）

用于：1:1 Chat、群聊成员、Agents 列表、Assistant 气泡等。

| 项 | 路径 |
| --- | --- |
| 静态资产 | `public/agent-avatars/` |
| 映射 | `src/lib/agent-avatar/presentation.ts`（`AGENT_AVATAR_ASSET_URLS` / `RUNTIME_ALIASES`） |
| 投影 API | `projectAgentIdentityAvatar`（`@/lib/agent-avatar`） |
| UI | `AgentIdentityAvatar`、`AssistantAvatar`、群聊 `MemberAvatar` |

### 规则

1. **形状**：UI 一律 `rounded-full` 圆框裁剪。
2. **底图**：按归一化后的 `runtime` / provider 取下表资产；未知 provider → Agorax 默认图。
3. **微章**：同一 provider 在 roster 中 **多于 1 个** 智能体时，圆框右下角叠 **两个字母**（多词取前两词首字母，单词取前两字）。例：六个 Hermes worker 共用 Hermes 底图，靠 `OR` / `RE` / … 区分。
4. **单 agent provider**：只显示 provider 圆图，无字母微章。

### Provider → 资产

| runtime（归一化） | 文件（相对 `public/agent-avatars/`） | 要求尺寸 |
| --- | --- | --- |
| hermes | `hermes-rounded.png` | **192×192** RGBA |
| claude-code | `claude-rounded.png` | **192×192** RGBA |
| codex | `codex-rounded.png` | **192×192** RGBA |
| cursor | `cursor-rounded.png` | **192×192** RGBA |
| opencode | `opencode-rounded.png` | **192×192** RGBA |
| openclaw | `openclaw-rounded.png` | **192×192** RGBA |
| kimi / kimi-code | `kimi-rounded.png` | **192×192** RGBA |
| deepseek-harness | `deepseek-rounded.png` | **192×192** RGBA |
| agorax / 未知（fallback） | `agorax-rounded.png` + 同图 `fallback.png` | **192×192** RGBA（两文件同像素） |

常见 agent id 别名（见 `RUNTIME_ALIASES`）：`cc-impl` → claude-code，`codex-impl` → codex，`cursor-impl` → cursor，等。

### 尺寸要求（资产 + UI）

**Identity 源文件（一律相同）**

| 项 | 要求 |
| --- | --- |
| 画幅 | **192×192 px**，严格正方形（勿 191×192 / 256 / 640） |
| 格式 | PNG，**RGBA**（圆角外透明） |
| 圆角 | **R = 36px**（见下方风格合同） |
| 导出密度 | 单份 192 即可；UI 用 `object-cover` 缩放到展示边长，无需 @2x 另档 |
| 文件体积 | 建议单张 < 50KB（软限制，便于列表密集加载） |

**Identity 常见 UI 展示边长**（组件 `size` prop，单位 CSS px；源图仍是 192）

| 场景 | 典型 `size` |
| --- | --- |
| 组件默认 / managed 面板 | 32 |
| Agents 侧栏列表 | 36 |
| 消息气泡 / Assistant | 28 |
| 群聊成员 | 24–32（视布局） |
| 空状态大图等 | 可更大（仍吃同一张 192 源图） |

> 展示尺寸由调用方传入，**不要**为每种 UI 尺寸各导一张 PNG。

### 投影示例

```ts
import { projectAgentIdentityAvatar } from '@/lib/agent-avatar'
import { AgentIdentityAvatar } from '@/components/avatars'

const presentation = projectAgentIdentityAvatar({
  name: 'Researcher',
  runtime: 'hermes',
  providerSiblingCount: 6, // → initials "RE"
})
```

### 怎么换

| 目标 | 做法 |
| --- | --- |
| 换某个 provider 底图 | 用同名 PNG 覆盖 `public/agent-avatars/<name>-rounded.png`（须符合下方风格合同） |
| 新 provider | 放入新 PNG，并在 `AGENT_AVATAR_ASSET_URLS` + `RUNTIME_ALIASES` 增加映射 |
| Hermes 六个 worker 各自不同图 | 今日共用一张底图；要 per-id 需改投影逻辑（当前合同不支持） |
| 生效 | 覆盖文件后硬刷新即可；改映射需重建/热更前端 |

### 风格合同（Identity 底图）

**基准族**：白底 soft app-icon — 以 `claude-rounded.png` / `cursor-rounded.png` / `openclaw-rounded.png` 为准（`opencode` 接近，画幅略偏）。

| 维度 | 要求 |
| --- | --- |
| 画幅 | **192×192** PNG，正方形 |
| 通道 | **RGBA**；圆角**外**透明，角上 alpha≈0 |
| 外形 | **圆角矩形（app icon）**，不是正圆遮罩，也不是直角满幅方图 |
| 圆角半径 | **36px @ 192×192**（边长的 **18.75%**，即 `R = 0.1875 × edge`）。换尺寸时按比例缩放，例如 256→`R=48` |
| UI 裁剪 | 组件侧固定 `rounded-full`（正圆裁切）；资产圆角必须统一，否则圆裁后四角透出量不一致 |
| 构图 | 居中品牌标；主体约占画幅 55–70%；四周留白均匀；标不要顶到圆角 |
| 底色 | **浅色 / 白** soft 底（可有极轻阴影或渐变）；避免整图黑底 |
| 层次 | 一层标 + 一层底即可；避免「圆 → 圆角方 → logo」三层嵌套（codex 现状） |
| 题材 | **品牌符号 / 几何标**；不做人物插画、不做写实照片 |
| 光影 | 可有轻微 soft UI 浮起感；勿强 3D 写实 |
| 禁止 | 黑底白标整图、二次元角色、正圆满幅遮罩、直角无圆角、与基准族明显不同的色板/线稿语言 |

**圆角对照（实测近似）**

| 文件 | 外形 | 等效 R @192 | 相对合同 |
| --- | --- | --- | --- |
| claude / cursor / openclaw | 透明外 + 圆角方 | **≈36px** | 基准 |
| opencode | 同上 | ≈37px | 接近（画幅 191×192） |
| codex | 透明外 + 内缩更多 | ≈27px（且 256 源） | 偏小 + 规格漂移 |
| agorax | 近正圆遮罩 | ≈93px | **过大（几乎正圆）** |
| hermes | 直角满幅、无透明角 | 0 | **无圆角** |
| kimi / deepseek | 黑底满幅方 | 0 | **无圆角** |

`fallback.png` 与 `agorax-rounded.png` 应保持同图；重做 Agorax 底图时两处一起换。

**现状分组（待对齐）**

| 组 | 文件 | 说明 |
| --- | --- | --- |
| 接近基准 | claude、cursor、openclaw | 白底 soft + R≈36 + 居中标 |
| 略偏 | opencode（尺寸）、codex（多层 + R 偏小）、openclaw 题材（角色标） | 次优；可择机收紧 |
| 偏离 | hermes（人物 + 无圆角）、kimi / deepseek（黑底 + 无圆角）、agorax（黑底 + 近正圆） | **优先重做** |
| 规格漂移 | kimi / deepseek（640×640 调色板）、hermes（无 alpha）、codex（256）、opencode（191×192） | 替换时一并改成 192×192 RGBA、R=36 |

### 替换验收清单

新图覆盖进 `public/agent-avatars/` 前逐项打勾：

- [ ] 文件名与 `AGENT_AVATAR_ASSET_URLS` 中 URL 一致（如 `hermes-rounded.png`）
- [ ] 192×192、RGBA PNG（`file` / 看图软件确认）
- [ ] 外形为圆角矩形：四角透明，**R = 36px**（可用设计稿圆角或与 claude 叠图比对）
- [ ] 不是正圆遮罩、不是直角满幅方图
- [ ] 白底 soft 构图，居中符号，无人物插画
- [ ] 非整图黑底；与 claude / cursor / openclaw 并排时风格与圆角一致
- [ ] UI `rounded-full` 圆裁后四角透出量与基准图一致、无糊边（Chat / Agents 列表硬刷新目视）
- [ ] 同 provider 多 agent 时双字母微章仍可读（底图勿过花、右下角留一点对比）
- [ ] 若改的是 agorax：同步更新 `fallback.png`
- [ ] 无需改组件；仅新 provider 才改 `presentation.ts`

---

## 2. 品牌 / PWA / 登录（产品 logo，非 agent 头像）

| 用途 | 路径 | 要求尺寸 |
| --- | --- | --- |
| 侧栏 / Onboarding / 启动屏 | `public/agorax-icon-512.png` | **512×512** RGBA |
| PWA / 小图标备用 | `public/agorax-icon-192.png` | **192×192** RGBA |
| Favicon | `public/agorax-favicon.png` | **32×32** RGBA |
| Apple touch | `public/agorax-apple-touch-icon.png` | **180×180** RGBA |
| 横幅 / wordmark | `public/agorax.png` | 宽幅自定（现状约 1536×415）；保持比例 |
| 方图营销 | `public/agorax-image.png` | 建议 **≥462×462** 正方形 |
| OG / 封面 | `public/cover.png` | **1200×630**（常见社交预览比） |

**替换**：按上表尺寸覆盖；侧栏引用 `/agorax-icon-512.png`（UI 再缩到约 28–112px 展示）。Hermes Identity 底图只用 `public/agent-avatars/hermes-rounded.png`。

---

## 3. Provider logo（设置 / Onboarding）

| 项 | 说明 |
| --- | --- |
| 路径 | `public/providers/*.png`（openai、anthropic、nous、kimi 等） |
| 用途 | 登录、provider 选择等 |
| 特点 | **不是** Chat agent 圆头像 |

**尺寸要求**

| 项 | 要求 |
| --- | --- |
| 画幅 | **640×640** 正方形（与现有多数 provider 图一致） |
| 格式 | PNG；RGBA 优先（调色板 P 模式可接受但不推荐） |
| 例外 | 极简单色标可更小（如现状 `nvidia.png` 64×64），但新图仍建议 640 |
| UI 展示 | 列表/对话框约 20–24px；吃同一张源图缩放 |

**替换**：覆盖对应 PNG，保持 640×640。

Managed 聊天（Claude Code / Codex 等）头像与 Hermes 相同，走 **§1 Agent Identity**（`AssistantAvatarProvider` + `resolveAgentAvatarSrc`），不再使用独立 SVG Mark。

---

## 4. 用户头像（真人）

| 项 | 说明 |
| --- | --- |
| 组件 | `UserAvatar`（`src/components/avatars/user-avatar.tsx`） |
| 数据 | Chat settings 中的 `avatarDataUrl`（设置页裁剪上传） |
| 仓库文件 | **无**固定静态图 |
| 未设置时 | Hugeicons 人形图标 |
| UI 展示 | 侧栏等常见 **28px**；圆角约 `0.2 × size`（非正圆） |

**上传建议**（产品侧，非仓库资产）：裁剪后边长 **≥128px**（推荐 256–512），正方形；存 data URL，勿塞进 `public/`。

**替换**：用户在 Settings → Profile 上传；开发侧不换仓库资产。

---

## 5. 其它可视化（非 Identity 底图文件）

Swarm / Office / Activity 面板的 agent 头像与 Chat 相同，一律用 **§1 Agent Identity**（`AgentIdentityAvatar` + `hermes-rounded.png` + 双字母微章）。不再使用独立像素机器人组件。

| 系统 | 位置 | 特点 | 怎么换 |
| --- | --- | --- | --- |
| **Gateway AgentAvatar** | `src/screens/gateway/components/agent-avatar.tsx` | Dashboard/Office emoji 槽位（🔍✍️📝…）；按索引循环 | 改 `AGENT_AVATARS` 常量 |
| **emoji glyph** | Swarm worker settings `avatarGlyph` | 可选 emoji 文案叠在卡片上（不是头像底图） | UI / 设置写入 |

---

## 6. 尺寸速查（全站）

| 类别 | 路径模式 | 源文件要求 | 常见 UI |
| --- | --- | --- | --- |
| Agent Identity | `public/agent-avatars/*-rounded.png`、`fallback.png` | **192×192** RGBA，R=36 | 28–36px 圆裁 |
| 产品大图标 | `agorax-icon-512.png` | **512×512** | 侧栏 / 启动 ~28–112px |
| 产品小图标 | `agorax-icon-192.png` | **192×192** | PWA 等 |
| Favicon | `agorax-favicon.png` | **32×32** | 浏览器标签 |
| Apple touch | `agorax-apple-touch-icon.png` | **180×180** | iOS 主屏 |
| OG 封面 | `cover.png` | **1200×630** | 链接预览 |
| Provider logo | `public/providers/*.png` | **640×640** | ~20–24px |
| 用户头像 | settings data URL | 建议 ≥128（推荐 256–512） | ~28px |

## 7. 替换速查

| 想换什么 | 做什么 |
| --- | --- |
| Chat / Agents / Groups 成员图 | 换 `public/agent-avatars/*-rounded.png`（192×192，必要时改 `presentation.ts`） |
| 产品 logo | 按尺寸表换 `public/agorax-icon-*.png` 等 |
| Provider 登录图标 | 换 `public/providers/*.png`（640×640） |
| 用户自己的脸 | Settings → Profile 上传 |
| Swarm / Office 头像 | 同 Identity（`hermes-rounded.png`）；勿另做像素人 |
| Gateway emoji 槽 | 改 gateway `AGENT_AVATARS` |

日常替换 agent 头像：**只动 `public/agent-avatars/` + 必要时改 `src/lib/agent-avatar/presentation.ts`。**
