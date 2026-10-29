# E2E Testing Guide for Agents

本文档记录了在 Agorax E2E 测试开发中的经验和最佳实践。

项目通用规则见 [AGENTS.md](../AGENTS.md)，安装、完整运行说明与报告位置见
[README.md](./README.md)。本指南针对 Cucumber + Playwright 测试开发，不替代产品合同。

## 测试策略：体验驱动的 E2E 测试

以完整用户操作和可观察结果为基准，保护聊天、会话恢复与群聊的核心体验。
每个场景验证一个明确的行为，不以“页面打开了”代替业务断言。

### 当前覆盖

| 模块       | 行为                                         | 场景标签              |
| ---------- | -------------------------------------------- | --------------------- |
| Chat       | 快速重复提交只产生一条新用户消息             | `@CHAT-SEND-001`      |
| Chat       | 生成期间的后续消息进入队列，不改变旧回复归属 | `@CHAT-TURN-001`      |
| Chat       | 新一轮发送后旧回复保持可见，用户消息不重复   | `@CHAT-TURN-002`      |
| Recovery   | 已完成历史不重复，界面处于空闲态             | `@CHAT-RECOVERY-001`  |
| Recovery   | 刷新后清理已完成会话的过期 waiting 状态      | `@CHAT-RECOVERY-002`  |
| Group Chat | SSE 刷新先于 POST 返回时，消息不重复         | `@GROUP-SEND-001`     |
| Lifecycle  | 流式结束后刷新保持最终回复且不重复           | `@CHAT-LIFECYCLE-001` |
| Lifecycle  | 发送失败后可重新发送成功                     | `@CHAT-LIFECYCLE-002` |
| Lifecycle  | 流式中切换会话不串消息                       | `@CHAT-LIFECYCLE-003` |
| Lifecycle  | 停止生成后可重新发送成功                     | `@CHAT-LIFECYCLE-004` |
| Soak       | 固定种子的同页多轮聊天保留消息与草稿         | `@CHAT-SOAK-001`      |

覆盖范围以 `src/features/` 为准。真实网络重连、多标签页、移动布局与 managed
协议仍需补充；短轮次耐久通过不代表已完成数小时运行或内存泄漏验证。

### 标签与执行分层

- `@smoke`：快速验证关键入口与基础行为
- `@regression`：固定回归场景
- `@chat` / `@group-chat`：业务模块
- `@P0` / `@P1` / `@P2`：风险和优先级，不代表已经配置了对应 CI
- `@soak`：同页多轮耐久测试，通过 `pnpm test:e2e:soak` 单独运行
- `@skip`：暂不执行，必须说明原因和恢复条件

## 目录与职责

```text
e2e/
	src/
		features/       Gherkin 用户场景和预期结果
		steps/          Playwright 操作、观察与断言
		mocks/          API fixture、SSE 和请求时序控制
		support/        AgoraxWorld、浏览器生命周期与失败证据
	helpers/          可复用页面辅助函数
	reports/          自动生成的报告和 trace，不提交
	cucumber.config.js
	tsconfig.json
```

将协议模拟放在 mocks，将业务断言放在 steps。场景独有状态放在 `AgoraxWorld`，
不要使用跨场景可变全局状态。共享浏览器进程，每个场景创建并关闭独立 context。
旧 `*.spec.ts` 已迁移；Cucumber 是唯一 E2E 入口，Playwright 提供浏览器和断言。

## 环境与运行

所有命令从 Agorax 仓库根目录执行。测试 runner 不会自动启动 UI 服务。
优先使用仅供测试的 localhost UI，关闭真实 Agent 自动启动，不重启已有服务。

```bash
# Linux/macOS：单独终端启动 UI
AGORAX_AUTO_START_AGENT=false pnpm exec vite dev --host 127.0.0.1 --port 6745

# 不启动浏览器：检查步骤注册和类型
pnpm test:e2e --dry-run
pnpm exec tsc -p e2e/tsconfig.json

# 浏览器验证
BASE_URL=http://127.0.0.1:6745 pnpm test:e2e
BASE_URL=http://127.0.0.1:6745 pnpm test:e2e:smoke
BASE_URL=http://127.0.0.1:6745 pnpm test:e2e --tags @CHAT-TURN-001
BASE_URL=http://127.0.0.1:6745 E2E_SOAK_ROUNDS=100 E2E_SEED=12345 pnpm test:e2e:soak
HEADLESS=false BASE_URL=http://127.0.0.1:6745 pnpm test:e2e:smoke
```

PowerShell 使用 `$env:BASE_URL = 'http://127.0.0.1:6745'` 等环境变量赋值，
不要直接复制 POSIX 的命令前缀。测试默认 URL 为 `http://127.0.0.1:6734`；
`BASE_URL` 优先于 `PLAYWRIGHT_BASE_URL`。

## Mock 实践

### 隔离真实数据

在 `page.goto()` 之前安装 mock。使用测试生成的会话和房间 ID，不读取已有会话，
不向真实模型发送请求，不依赖本机 profile、账号或凭据。Hermes 与 managed 的协议
存在差异，覆盖一轨不能宣称另一轨已验证；新增 runtime 场景应适配对应协议。

浏览器拦截不覆盖服务端启动和 SSR；不要把它当作后端隔离或网络沙箱。
通用 API fixture 不能替代场景关键接口的准确响应，也不能掩盖协议变化。

### 流式响应

Chat mock 使用浏览器端 fetch 拦截与 `ReadableStream`，发送 Agorax 的
`started`、`chunk` 等事件。忙碌场景保持流打开，context 关闭时回收。
不要照搬 LobeHub 的 `/webapi/chat/` 路径和 SSE 格式。

`route.fulfill()` 会缓冲响应，不能模拟真实的逐块到达时间。
需要测试流式完成、取消或失败时，为 mock 增加明确的控制方式，并匹配产品协议；
不能仅让一个始终不关闭的流通过所有场景。

### 竞态复现

群聊重复发送场景必须证明如下顺序：

1. 用户发送消息，POST 已进入等待门
2. 发布 `group_chat_message`，列表读取包含同一消息 ID
3. 确认页面已经显示一条消息，再放行 POST
4. 确认仍为一条消息，刷新后也保持一致

使用 promise gate 控制顺序。不要只加随机延迟，然后假定目标竞态发生过。
清理路径必须释放等待门并关闭 context，避免失败后挂住进程。

## 定位与断言

- 优先使用可访问角色和稳定的 `data-testid`，例如 `chat-composer-input`、
  `chat-composer-send-button` 与 `data-chat-message-bubble`
- 当前聊天输入可使用 `fill()`；不要照搬其他项目针对特定富文本编辑器的限制
- 用 `toHaveCount()`、`toHaveText()`、`toHaveValue()` 和 `expect.poll()` 等待结果
- 消息断言绑定本轮 prompt、预期内容及会话，避免任意旧回复满足条件
- strict mode 报错时先收紧定位范围，不默认用 `.first()` 隐藏重复渲染
- 不使用空 catch、吞掉超时或无条件 fallback 将失败变成通过
- 时序采样可以有明确间隔；页面就绪与请求完成应等待可观察信号

瞬时闪烁与长期资源增长需要额外采样。间隔检查几次可见性不能证明每一帧都稳定，
短回归全部通过也不能证明没有泄漏。

## 调试与失败证据

首先查看 `e2e/reports/cucumber.html` 或 JSON 报告中的失败步骤。
当前 hooks 会在场景失败时附加截图、页面异常和操作记录，并保存 Playwright trace：

```bash
pnpm exec playwright show-trace e2e/reports/artifacts/<session-id>.zip
```

从 trace 检查导航、DOM、请求和时序。输入框未出现时，先确认认证、首次引导、
更新弹窗及 fixture 形状，不要立即增加所有 timeout。测试 context 应预设引导与
更新提示标记，不修改真实用户设置。

报告文件会被后续运行覆盖，必要时先归档。截图和 trace 可能包含页面数据，
不要提交敏感材料。遇到失败优先修正测试环境或断言；确认产品缺陷后单独记录，
不要通过放宽断言或自动重试隐藏它。

## 耐久测试扩展

耐久场景应在同一 context、同一页面内连续执行，保留累计状态，并记录随机种子、
操作序列和扰动参数。重建页面的重复 E2E 不能替代长时间使用测试。

当前耐久场景覆盖逐轮发送、完成、消息数量、流式中草稿保留与页面身份不变。
种子控制 prompt 和草稿分支，后续可扩展多标签页及真实重连扰动。
内存与 DOM 数量应在预热后观察趋势，不能用一次峰值认定泄漏。
长时间运行要分段采集 trace，控制证据体积，并与默认短回归分开。
现有 runner 每 25 轮丢弃成功片段，失败保留当前片段和操作记录。

tsx 会为类和具名函数插入 `__name` 辅助函数。通过 `addInitScript` 注入复杂
模拟器时使用原始 JavaScript 字符串，避免序列化后引用浏览器中不存在的辅助函数。

## 新增测试流程

1. 明确用户操作、风险与唯一预期结果，先检查已有场景是否可扩展
2. 在对应业务目录添加 feature，使用稳定场景标签，新增描述优先中文
3. 复用步骤和页面 helpers，协议或时序差异放入 mock
4. 先跑 dry-run 和独立类型检查，再实跑受影响场景及必要的相邻场景
5. 报告实际命令、场景数量、结果与未验证范围；零场景不算验证通过
6. 同步更新 README 的覆盖说明，保留足以复现失败的证据

Mock 场景验证前端对指定协议和时序的处理，不证明真实 gateway 或 managed runtime
会输出相同事件。真实集成行为需要单独验证。
