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
| kimi / kimi-code | `kimi-rounded.png` | **192×192** RGBA |
| agorax / 未知（fallback） | `agorax-rounded.png` | **192×192** RGBA（`agorax` / `fallback` 同 URL） |
| openclaw | （资产暂缺） | 暂用 `agorax-rounded.png`；需要时再加 `openclaw-rounded.png` |
| deepseek-harness | （资产暂缺） | 暂用 `agorax-rounded.png`；需要时再加 `deepseek-rounded.png` |

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
| 构图 | 居中品牌标；Agorax 脚本默认主体 **76%** 画幅（合同范围约 55–80%）；四周留白均匀；标不要顶到圆角 |
| 底色 | **浅色 / 白** soft 底（可有极轻阴影或渐变）；避免整图黑底 |
| 层次 | 一层标 + 一层底即可；避免「圆 → 圆角方 → logo」三层嵌套（codex 现状） |
| 题材 | **品牌符号 / 几何标**；不做人物插画、不做写实照片 |
| 光影 | 可有轻微 soft UI 浮起感；勿强 3D 写实 |
| 禁止 | 黑底白标整图、二次元角色、正圆满幅遮罩、直角无圆角、与基准族明显不同的色板/线稿语言 |

**画幅 + 底板（已统一）**：`public/agent-avatars/*-rounded.png` 全部为：

| 项 | 值 |
| --- | --- |
| 画幅 | **192×192** 严格正方形 |
| 通道 | **RGBA**，四角透明（A≈0） |
| 底板 | **浅色 / 白 soft**（可有轻阴影） |
| 圆角 | **R = 36px**（边长 18.75%；顶边首个不透明点 @x≈36） |
| 标占比 | 约 **76%**（hermes 人像约 92% 以免过小） |

| 文件 | 备注 |
| --- | --- |
| agorax | 脚本生成：白 soft + 黑标 |
| claude / cursor / opencode | 白 soft + 原品牌色标 |
| codex | 品牌图缩至 192（与 kimi 同类处理） |
| kimi | 品牌图缩至 192（黑底白 K，圆角自带；与白 soft 族略异） |
| hermes | 人像插画裁进白 soft 圆角方（题材仍为人像，外形已齐） |
| openclaw / deepseek | **暂无独立 PNG**；映射到 agorax，用时再补资产 |

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
- [ ] 若改的是 agorax：跑 `node scripts/generate-pwa-icons.js`（或直接覆盖 `agorax-rounded.png`）
- [ ] 无需改组件；仅新 provider 才改 `presentation.ts`

---

## 2. 品牌 / PWA / 登录（产品 logo，非 agent 头像）

多数尺寸由脚本从源图生成，**不要**手改各尺寸衍生文件后忘了源图。

### 源图（手维护）

| 路径 | 用途 | 要求 |
| --- | --- | --- |
| `public/agorax-image.png` | 品牌矢量标；PWA / favicon / Identity Agorax 的**唯一视觉源** | 见下表 |
| `public/agorax.png` | 横幅 wordmark（README / OG） | 见下表；**手拼成品**，不进 PWA 脚本 |

**`agorax.png` 横幅 wordmark 规格**

| 项 | 要求 |
| --- | --- |
| 格式 | **PNG + RGBA**；透明底（深色 README / OG 下看白字与白 soft 标） |
| 构图 | 左：Identity 同款白 soft 圆角方 + 黑 AX 标（可用 `agorax-rounded.png`）；右：文案 **`AgoraX`** |
| 对齐 | 图标高度 = 文字**大写高度**（cap height）；顶对齐；`g` 下行可略伸出图标底 |
| 字体 | **[Alkatra](https://fonts.google.com/specimen/Alkatra)** Bold（可变字体 `wght=700`）；Google Fonts / SIL OFL 1.1 |
| 字体文件 | **不入库**。重渲时从 [google/fonts `ofl/alkatra`](https://github.com/google/fonts/tree/main/ofl/alkatra) 取 `Alkatra[wght].ttf`（本地可暂放 `public/fonts/`，勿提交） |
| 仓库真相源 | 只跟踪烤好的 `public/agorax.png`；换字重/字号后覆盖该 PNG 即可 |

**`agorax-image.png` 源图规格（现状已对齐）**

| 项 | 要求 |
| --- | --- |
| 画幅 | **正方形**；现状 **1024×1024**（最低建议 ≥512，避免生成 512 时被放大） |
| 格式 | **PNG + RGBA** |
| 四角透明 | 画布仍是正方形，但四角像素 **A≈0**（不是白/黑实心角）。深色 UI 下只看到标，不出现大方色块 |
| 标本身 | **透明底上的深色/黑色笔画**（RGB 可为纯黑）；**不要**铺满白底，也不要用「白底 + 半透明挖空」假透明 |
| 体积 | 软限制；现状约 250KB 可接受 |

> **PNG + RGBA，四角透明**：带 Alpha 通道的 PNG；角上全透，中间是标。预览时若背景是黑色，黑标会「融」进背景，属正常，请用棋盘格或浅色底查看。

### 脚本常量（全尺寸共用）

脚本：[`scripts/generate-pwa-icons.js`](../../scripts/generate-pwa-icons.js)（Pillow / `python3`）。

| 常量 | 值 | 说明 |
| --- | --- | --- |
| 底板外形 | 白 soft **圆角方**（非正圆） | favicon / apple-touch / 192 / 512 / Identity **同一套** |
| 圆角 R | 边长 × **18.75%**（192→36px，512→96px） | 与 Identity 合同一致 |
| 标占比 | 边长 × **76%**（`size * 0.76`） | 所有上述输出共用；改一处即全局 |
| 标颜色 | 压成**纯黑** + 保留 alpha | 源图可带彩色；脚本统一黑标以便深色 UI 靠白底托住 |
| 无 `fallback.png` | — | 未知 runtime 直接用 `agorax-rounded.png` |

```bash
node scripts/generate-pwa-icons.js
# 需：python3 -m pip install Pillow
```

### 衍生图（脚本生成，勿当源稿）

| 输出 | 尺寸 | 说明 |
| --- | --- | --- |
| `agorax-favicon.png` | **32×32** | 白 soft 圆角方 + 黑标（76%） |
| `agorax-apple-touch-icon.png` | **180×180** | 同上 |
| `agorax-icon-192.png` | **192×192**，R=36 | 同上 |
| `agorax-icon-512.png` | **512×512**，同比圆角 | 侧栏 / Onboarding / 启动屏 |
| `agent-avatars/agorax-rounded.png` | **192×192** | 与 icon-192 同算法；Identity Agorax + 未知 runtime |

**换品牌 / 调占比流程**

1. 替换 `public/agorax-image.png`（须符合上表），或改脚本里的 `0.76` / 圆角比例
2. 跑 `node scripts/generate-pwa-icons.js`
3. 硬刷新 UI；侧栏看 `/agorax-icon-512.png`，Chat 未知 runtime 看 `agorax-rounded.png`

Hermes 及其它 provider 的 `public/agent-avatars/*-rounded.png` **不**走此脚本，须手供并符合 §1 风格合同。

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
| Agent Identity | `public/agent-avatars/*-rounded.png` | **一律** 192×192 RGBA + 白 soft + **R=36**（agorax 脚本生成） | 28–36px 圆裁 |
| 品牌源图（标） | `agorax-image.png` | **1024×1024** PNG RGBA，四角透明，黑标 | 仅作生成源 |
| 品牌源图（横幅） | `agorax.png` | PNG RGBA；Alkatra Bold「AgoraX」+ 标 | README / OG |
| 产品大图标 | `agorax-icon-512.png` | **512×512** 白 soft 圆角方+黑标 76% | 侧栏 / 启动 ~28–112px |
| 产品小图标 | `agorax-icon-192.png` | **192×192** 同上 | PWA 等 |
| Favicon | `agorax-favicon.png` | **32×32** 同上 | 浏览器标签 |
| Apple touch | `agorax-apple-touch-icon.png` | **180×180** 同上 | iOS 主屏 |
| Provider logo | `public/providers/*.png` | **640×640** | ~20–24px |
| 用户头像 | settings data URL | 建议 ≥128（推荐 256–512） | ~28px |

## 7. 替换速查

| 想换什么 | 做什么 |
| --- | --- |
| Chat / Agents / Groups 成员图 | 换 `public/agent-avatars/*-rounded.png`（192×192，必要时改 `presentation.ts`） |
| 产品 logo / Agorax Identity | 换 `agorax-image.png`（或改脚本 76%）后跑 `node scripts/generate-pwa-icons.js` |
| 横幅 wordmark | 按 §2「`agorax.png` 规格」用 Alkatra Bold 重拼，覆盖 `public/agorax.png`（字体不入库） |
| 标占比 | 改 `scripts/generate-pwa-icons.js` 内 `size * 0.76`，再跑脚本 |
| Provider 登录图标 | 换 `public/providers/*.png`（640×640） |
| 用户自己的脸 | Settings → Profile 上传 |
| Swarm / Office 头像 | 同 Identity（`hermes-rounded.png`）；勿另做像素人 |
| Gateway emoji 槽 | 改 gateway `AGENT_AVATARS` |

日常替换 agent 头像：**只动 `public/agent-avatars/` + 必要时改 `src/lib/agent-avatar/presentation.ts`。**
