# Platform Skills 缺陷分析与同步改造方案

状态：分期实施中。下文缺陷证据是改造前基线；当前行为以 [platform-skills.md](platform-skills.md) 为准。

## 实施进度

已实现完整文件树、文本附件编辑/新增/移除、二进制下载、事务与 revision CAS、版本历史/恢复、完整包 hash、单端发布与跨 agent 同步、冲突保留/显式解决、部署状态、定期稳定快照检查、可恢复目录切换，以及非覆盖式发现和解绑意图。Hermes/default 与 managed 隔离文件包使用同一协调逻辑。

managed 文件包当前按需读取路径，不等价于原生发现。以下计划项仍未完成：daemon 原生技能根目录注入、全运行入口统一准备、SSH 交付、workspace override、source check/update、历史压缩与跨设备 Git 同步。没有把这些能力标为已完成。

后续双模式改造已落地：默认优先 Symlink，显式可选 Copy，链接失败可配置是否降级，并记录实际模式与原因。中央可编辑目录与 DB 不可变版本分开；文件事件采用 500ms 防抖、稳定检查、自写去重、3 秒监听集合刷新及 30 秒周期兜底。复制/链接切换、扫描、解绑与恢复复用归属和内容校验。详见当前合同；下文“首期统一 Copy”是早期设计决定，已由本段双模式合同替代。

验证记录：首个“本地编辑不丢失且传播到其他 agent”回归已在旧实现失败，并在修复后通过。模块自动化测试覆盖同步、冲突、版本、导入、恢复和路径边界；全仓库类型检查仍有非本模块错误。真实 CLI 加载、Windows 原生边界、完整 UI 截图和外部验收发布必须分别记录，不能由单元测试代替。

### 首批实现验证

- `pnpm exec vitest run src/server/platform-skills`：10 个文件、52 项测试通过。
- 本次变更范围 ESLint：0 error；TypeScript 最后复核为技能范围 0 error，全仓库仍有其他模块错误。
- 真实产品页面：脚本和参考文档目录可展开；参考文档经界面编辑、保存、刷新后内容保留；二进制附件成功下载。
- 真实 API 和隔离文件系统：`default` 与 `cc-impl` 绑定同一技能，修改 Hermes 参考文件后同步，managed 文件包内容一致，两端状态均为 `in-sync`。没有调用真实模型或 CLI。
- 桌面 1440px 与窄屏 390px 截图已经查看，窄屏 `scrollWidth=390`，没有横向溢出。截图保存在本地、Git 忽略的 [桌面证据](../e2e/reports/platform-skills-desktop-20261029.png) 与 [窄屏证据](../e2e/reports/platform-skills-mobile-20261029.png)，这些不是已上传的外部证据。
- 生产构建：客户端完成；SSR 在并行修改中的 `src/routes/api/swarm-dispatch.ts` 报 `Missing semicolon (36:2)`，未修改该文件，也不将整仓构建标为通过。
- 验证实例已停止，避免与其他 Vite 进程争抢路由生成文件；临时 worktree 已删除。当前没有可承诺稳定的独立预览 URL。
- 未取得改造前 UI 截图，未运行真实 runtime 或 Windows 原生文件 API，也没有独立验收 reviewer。环境无 `lh` 命令，因此没有发布 acceptance 链接。以上是明确的验收缺口，不由本地截图或测试结果替代。

### 双模式与事件监听验证

- 运行 `AGORAX_AUTO_START_AGENT=false pnpm exec vitest run src/server/platform-skills src/server/bootstrap.test.ts --maxWorkers=2`：11 个文件、63 项测试通过。
- 默认链接回归先在旧实现失败，再在新实现通过；另覆盖 Copy 独立冲突、模式双向切换、权限失败降级/严格不降级、外部链接保护、两条 runtime 的安全解绑和备份恢复。
- 真实文件事件可在 30 秒兜底前发布；确定性测试覆盖连续写入防抖、自写去重、watcher 不可用时的周期检查、切换目录后首事件丢失，以及停止后无残留计时器。
- 真实产品 UI 已完成 Symlink → Copy → Symlink 切换，文件系统类型与返回的 `actualMode` 一致。Copy 文件编辑自动回流；Symlink 的一端编辑立即被另一端读取，并自动写回 catalog。测试使用临时 home/数据库，没有调用真实模型。
- 桌面与 390px 窄屏已截图并查看，窄屏 `scrollWidth=390`。本地证据为 [Symlink 桌面](../e2e/reports/platform-skills-symlink-desktop-20261029.png)、[Copy 桌面](../e2e/reports/platform-skills-copy-desktop-20261029.png)、[窄屏设置](../e2e/reports/platform-skills-modes-mobile-20261029.png)。
- 本次代码 lint 无 error；最终技能范围类型诊断为 0。整仓类型检查仍有其他模块诊断，未标记为通过。Windows 权限失败为边界模拟，真实 Windows symlink/junction 尚未实测。
- 本轮没有发布外部 acceptance；没有独立 reviewer 或真实 runtime 热加载证据。隔离验证预览目前已停止。

## 1. 结论与范围

当前 Platform Skills 是「共享 catalog + agent 绑定 + 部分单向分发」，不是完整的同步系统。平台编辑接口已经尝试向所有绑定的 Hermes agent 重新物化；真正缺失的是本地修改回收、部署基线、冲突判断、失败恢复，以及 managed runtime 的原生交付。

建议保留 `collab.db` 为逻辑真相源，演进为「版本化技能包 + 目标部署记录 + 双向协调」。不要仅增加 watcher，也不要直接把 skills-manager 作为第二套数据库/真相源接入。

必须区分三种需求：

| 范围 | 目标 | 本方案安排 |
| --- | --- | --- |
| 同机跨 agent | agent A 修改后，经平台发布到已绑定的 B/C | 核心交付 |
| 跨 workspace | 技能身份共享，但绑定、覆盖与实际可见范围明确 | 核心交付中的作用域合同 |
| 跨机器 | 不同设备交换版本和配置，处理离线冲突 | 后续独立增量，不冒充同机同步 |

初始分析只使用静态代码与公开资料；实施验证使用临时数据库、profile 目录和伪造下载响应，没有修改真实用户技能或执行真实 agent。下述缺陷列表保留为改造前证据；现场 runtime 缓存与外部加载行为仍需单独验证。

## 2. 已确认缺陷

P0 表示可能丢失已有编辑，应先止损；P1 表示核心行为错误或缺失；P2 表示可观测性、易用性及后续能力。

| 编号 | 级别 | 缺陷、影响与代码依据 |
| --- | --- | --- |
| F01 | P1 | **没有可靠的 agent 本地修改回流。** catalog 扫描跳过平台 marker；绑定循环只有当前扫描没有同名映射时才 upsert；已有映射不会比较其他副本。Agent 本地导入也跳过已管理/已入库项目。不是完全没有偶发回流，而是没有确定的同步语义。见 [seed.ts](../src/server/platform-skills/seed.ts#L198)、[agent-local-skills.ts](../src/server/platform-skills/agent-local-skills.ts#L117)。 |
| F02 | P0 | **后续操作可能抹掉本地编辑。** 物化对有 marker 的目录直接删除重建，不比较磁盘内容；一次绑定/开关会重写该 agent 的所有绑定技能，不只是本次操作的技能。解绑和 catalog 删除也没有 dirty 检查。见 [materialize.ts](../src/server/platform-skills/materialize.ts#L42)、[skills.ts](../src/routes/api/agents/$agentId/skills.ts#L72)。 |
| F03 | P0 | **同名不同源被静默折叠，扫描可反向覆盖平台编辑。** 扫描按 lowercase name 保留首个候选，store 又按规范化 name upsert，覆盖内容、附件和 origin；不检查是否同源或存在本地变更。见 [scan-skill-fs.ts](../src/server/platform-skills/scan-skill-fs.ts#L266)、[store.ts](../src/server/platform-skills/store.ts#L188)。 |
| F04 | P1 | **“同步本地”与更新分发断开。** seed API 使用 `materialize: false`，即使扫描更新了 catalog，也不刷新 Hermes 副本；平台 PATCH 则会扇出。相同更新因入口不同结果不同。见 [seed API](../src/routes/api/platform-skills/seed.ts#L14)、[PATCH API](../src/routes/api/platform-skills/$skillId.ts#L88)。 |
| F05 | P1 | **绑定成功不等于已部署。** 同名无 marker 目录返回 `skipped-existing`，该结果未汇总返回；profile config 更新异常被吞掉。UI 只能看到绑定/启用，而不是冲突或失败。见 [materialize.ts](../src/server/platform-skills/materialize.ts#L38)、[materialize.ts](../src/server/platform-skills/materialize.ts#L107)。 |
| F06 | P1 | **managed 与 Hermes 能力不等价。** managed 物化直接 no-op；activate 默认只注入名称/描述，显式 `/name` 才注入全文与附件文本，不提供可执行的文件树，也不保证原生自动发现。见 [materialize.ts](../src/server/platform-skills/materialize.ts#L124)、[prompt-inject.ts](../src/server/platform-skills/prompt-inject.ts#L77)。 |
| F07 | P1 | **技能包有损导入。** GitHub 导入跳过全部子目录并最多收集 64 个文件；ZIP 忽略不能 UTF-8 解码的文件；bundle 跳过部分二进制和超限文件；FS 扫描把二进制按 UTF-8 读取，重写可能损坏字节，且未保存执行权限。见 [import-from-url.ts](../src/server/platform-skills/import-from-url.ts#L140)、[parse-zip.ts](../src/server/platform-skills/parse-zip.ts#L14)、[skill-bundle.ts](../src/server/platform-skills/skill-bundle.ts#L75)、[scan-skill-fs.ts](../src/server/platform-skills/scan-skill-fs.ts#L81)。 |
| F08 | P1 | **agent/workspace 归属不准确。** 每个 managed runtime 的 agent roots 都加入整个仓库所有工具的 project skill roots，且通常使用控制面 `repoRoot`，没有绑定实际运行 workspace。相同 runtime 的多个 agent 还共用个人目录，无法据此证明 agent 级隔离。见 [agent-skill-roots.ts](../src/server/platform-skills/agent-skill-roots.ts#L82)、[managed-skill-roots.ts](../src/server/platform-skills/managed-skill-roots.ts#L39)。 |
| F09 | P1 | **DB 与文件系统更新不能恢复到一致状态。** catalog 先写入再逐 agent 分发，中途失败可能留下部分新、部分旧；写树先删后写，崩溃可留下半包。store 的多语句替换文件/绑定也没有局部事务，没有并发编辑版本条件。见 [store.ts](../src/server/platform-skills/store.ts#L87)、[store.ts](../src/server/platform-skills/store.ts#L346)、[PATCH API](../src/routes/api/platform-skills/$skillId.ts#L74)。 |
| F10 | P1 | **解绑和禁用不代表 runtime 不可见。** 未接管的本地目录被保留；managed 个人目录原有技能仍可被 CLI 原生发现，平台 toggle 只影响绑定/注入。旧 profile toggle 又直接写 config，不更新 DB。见 [toggle-skill.ts](../src/routes/api/profiles/toggle-skill.ts#L61)、[materialize.ts](../src/server/platform-skills/materialize.ts#L38)。 |
| F11 | P2 | **缺少内容身份、历史及上游更新链。** 当前 origin 只有 kind/source/importedAt，marker 只有 `1`，绑定只有 enabled；没有 revision、基线 hash、部署路径、diff、冲突和恢复记录。导入再次遇到同名会失败，不是更新。见 [types.ts](../src/server/platform-skills/types.ts#L1)、[collab-db.ts](../src/server/collab-db.ts#L294)、[import-skill.ts](../src/server/platform-skills/import-skill.ts#L17)。 |
| F12 | P2 | **UI 缓存失效不完整。** 详情页保存只失效 catalog/detail，绑定操作失效 `agent-skills`；Composer 的实际 key 是 `['chat','composer','agent-skills',agentId]`，不会被前者匹配，可能继续显示旧目录/内容直至再次刷新。见 [详情页](../src/screens/skills/platform-skill-detail-screen.tsx#L121)、[Composer](../src/screens/chat/components/chat-composer.tsx#L1266)。 |

另外存在较小但明确的解析问题：frontmatter 用正则解析，不支持常见 YAML 折叠/多行 description；seed 自动绑定只增不减，解绑后再次扫描可能复活；`setAgentSkills` 全量替换会把保留的 disabled 项也重置为 enabled。应分别用 YAML parser、解绑意图记录、保留既有 toggle 的差量更新解决。

### 用户报告对应的路径

1. A 是平台物化目录：本地编辑通常不被 catalog 扫描收录；如果别的未管理同名来源先被扫描，它还可能成为 catalog 的内容来源。
2. A 是未接管目录：扫描可能读到 A，也可能优先读到另一个同名目录；没有 hash 或来源身份来做正确判断。
3. 即使 catalog 被更新，手动 seed 不做分发；B 若存在未接管同名目录，PATCH 分发也会跳过。
4. B 是 managed：catalog 最新不等于 CLI 原生目录最新；当前仅部分 prompt 路径读取平台内容。

因此“一个 agent 更新而其他 agent 不更新”不是单个漏掉的函数调用，而是四个环节都没有形成闭环。

### 尚待现场验证，不作为已复现缺陷

- Hermes/各 managed CLI 是否缓存已加载技能，以及内容、目录列表、删除分别何时生效。
- SSH Hermes 的真实读取主机和目录；本地控制面写盘不能被当成远端部署成功。
- 所有群聊、Swarm、恢复会话路径是否统一经过能力准备入口；本轮只确认了 1:1 managed activate/input 的平台注入调用，不能据此推断其他路径已覆盖。
- 实际 skill 是否为 symlink，目标是否经过 `external_dirs`；当前 `Dirent.isDirectory()` 的遍历不识别普通子目录符号链接，需补充对应诊断与覆盖。
- URL fetch 的重定向/内网访问、ZIP 解压预算需要单独加固：目前请求大小与解压后预算并不等价，不能只依赖归一化后的文件限制。
- 现有测试主要覆盖 store、扫描和 prompt；seed-bind 测试复制了部分循环而非调用真实 seed，没有证明端到端同步。见 [seed-bind.test.ts](../src/server/platform-skills/seed-bind.test.ts#L17)。

## 3. skills-manager 的参考价值与边界

参考公开 README、管理 skill 和 core 源码；阅读的是当时的 `main`，正式实施前应固定 commit，不能把会移动的文档当作版本合同。

| 可借鉴 | Agorax 应如何使用 |
| --- | --- |
| 中央 Library、组织用 Preset、实际 Deployment 分离 | 保留 catalog/bindings，新增 deployment 事实，不用 DB 绑定冒充实际可见 |
| symlink/copy 双模式、runtime adapter、自定义目录 | 建 capability adapter；每种模式返回真实采用的方式，不默认所有 runtime 支持相同目录 |
| source 检查、更新与 diff 分离 | 增加 check/preview/apply，记录仓库、ref、subpath、解析后的 commit |
| hash、watcher、路径归属检查、操作日志 | 事件触发协调，但操作前重新检查内容与目录归属；用日志定位部分失败 |
| 项目工作区双向同步、Git 备份与冲突入口 | 同机闭环先落地；跨设备按 skill identity 交换版本，不同步机器路径或整个 DB |
| CLI 与桌面共享核心 | Agent 通过平台 API/CLI 管理技能，不绕过平台直接改内部 DB |

不能直接照搬的限制：参考项目 `manage-skills` 文档明确说明，某些 update 会覆盖“新版本仍包含的同路径文件”的本地编辑；`sync_engine` 的 copy freshness 主要比较 source hash 与目标存在性，不等价于完整的目标 dirty 检测；其 watcher 通知刷新也不自动证明任意 agent 修改都被双向发布。Agorax 需要更严格的三方判断。

参考：

- [README](https://github.com/xingkongliang/skills-manager#readme)
- [manage-skills](https://github.com/xingkongliang/skills-manager/blob/main/skills/manage-skills/SKILL.md)
- [sync_engine.rs](https://github.com/xingkongliang/skills-manager/blob/main/src-tauri/src/core/sync_engine.rs)
- [content_hash.rs](https://github.com/xingkongliang/skills-manager/blob/main/src-tauri/src/core/content_hash.rs)
- [file_watcher.rs](https://github.com/xingkongliang/skills-manager/blob/main/src-tauri/src/core/file_watcher.rs)

## 4. 目标合同

### 身份、版本与作用域

- `skillId` 为稳定身份；name 是可改的触发名称，不是跨源判同依据。相同 name 不同来源必须展示冲突，允许显式关联或 fork，禁止首个胜出。
- 保留现有唯一 name 约束作为首期触发命名空间约束；新来源同名先进入候选区，由用户选择关联或使用新 name，不必第一期改成可重名 catalog。
- `collab.db` 保存逻辑包版本和绑定意图；部署目录只是可观测、可编辑的副本。落盘缓存不是第二个内容真相源。
- 已接管且启用自动同步的部署副本可作为编辑入口：单端修改、基线明确且无冲突时自动发布到 catalog，再分发到其他绑定；原始外部来源默认只检查，不自动接管或覆盖。
- 绑定仍使用 registry id，覆盖 Hermes、managed、`default`；`dispatchable: false` 不影响能力绑定。
- 当前 agent 级绑定是默认值；增加明确 workspace override（inherit/enable/disable）时以差量实现，禁止扫描某个项目后把它变成所有 agent 的全局技能。
- 同一真实 profile/skills root 被多个 agent 共享时，要合并成同一物理部署目标；不同绑定意图无法同时满足时显示 scope conflict，不能让最后一次物化获胜。

### 禁用与生效

- bind 表示期望可用，部署记录表示已交付，runtime observation 表示已被发现。三者分开。
- disable：阻止平台提供该技能，并按 runtime 能力执行隐藏/禁用；外部自有目录依然可见时显示 `external-visible`，不能声称已彻底禁用。
- unbind：删除平台意图，仅清理经校验属于平台且无未发布编辑的部署；dirty 副本先保全并提示，不静默删。
- 本地删除默认表示部署 missing，不直接删除全局 catalog；平台修复可重建。全局删除必须走显式 API，保留 tombstone 和可恢复版本。
- 已开始的 turn 固定使用准备时的 revision；更新用于后续可安全加载的 turn/session。runtime 不支持热刷新时明确 `restart-required`，不偷偷重启或打断活动运行。

## 5. 数据模型

在现有表基础上增量迁移，第一阶段不引入独立同步服务或第二套 DB。

| 实体 | 建议字段与职责 |
| --- | --- |
| `platform_skills` | 保留 id/name/展示字段，增加 `head_revision_id`、逻辑删除状态；不以 `updated_at` 决定内容新旧 |
| `skill_revisions` | id、skill_id、parent_revision_id、tree_hash、manifest、author/origin、created_at；不可变 |
| `skill_revision_files` | revision_id、规范相对 path、原始 bytes BLOB、可执行标志；完整包，包含 SKILL.md |
| `skill_sources` | skill_id、kind、定位信息、ref/subpath/resolved_commit、last_checked；外部来源与部署副本分离 |
| `agent_skills` | 保留 agent_id/skill_id/enabled；增加显式解绑/来源策略，防止 seed 复活用户已删除的绑定 |
| `skill_deployments` | 稳定 target id、skill_id、agent/workspace 关联、runtime、host、canonical root/path、mode、desired/applied/base revision、observed hash、status、last_error、checked_at |
| `skill_sync_operations` | 操作 id、幂等键、目标版本/代次、状态、分目标结果、重试信息、关联冲突快照；兼作 durable work queue 和审计记录 |

物理目录共享时，用 target 与 agent/workspace 的关联表达多对多，不为同一路径创建相互竞争的写入记录。目录归属与约束在新增 deployment 时检查。

旧 API 的 `content/files` 从 head revision 投影，保持客户端兼容；完成迁移后不维护两套可独立写入的内容列。现有小规模技能包先用 SQLite BLOB，设置单文件/整包/历史保留预算；性能证明需要时再把 bytes 抽为内容寻址对象。

完整包 hash 使用排序后的路径、文件类型、长度分隔的原始 bytes、可执行标志计算，排除平台 marker 和明确的运行时缓存。字节身份不做 CRLF 折叠；仅展示 diff 可提供行尾归一化比较。拒绝不完整扫描生成“无变化”结论。

新 marker 至少记录格式版本、skillId、deploymentId、appliedRevision。marker 仅是线索，操作前还要核对 DB 路径、`lstat` 类型和包内容，不能以“存在 marker”作为删除授权。

## 6. 双向协调算法

对每个目标定义：`B` 为该部署已知基线，`C` 为 catalog 最新版本，`D` 为磁盘当前内容。比较完整技能包，而非 mtime 或单个 SKILL.md。

| 条件 | 行为 |
| --- | --- |
| `D = B` 且 `C = B` | 无操作，检查 runtime observation |
| `D = B` 且 `C != B` | 可下发 C，成功后推进 applied/base revision |
| `D != B` 且 `C = B` | 已接管目标自动发布 D；通过 compare-and-swap 推进 head，再协调其他目标 |
| `D = C` 且都不同于 B | 内容已收敛，仅推进基线，不重复写盘 |
| `D != B`、`C != B` 且 `D != C` | 冲突，保留两端，不自动覆盖；其他无冲突目标继续 |
| 无基线、无权限、路径归属不明 | `unknown/conflict/error`，只诊断或显式 adopt，禁止猜测 |
| 目标不存在 | `missing`；不当成全局删除，按绑定意图修复 |

同一轮先收集所有副本的稳定快照再决策。多个目标都从同一个基线修改成相同内容时只发布一次；修改成不同内容时直接报冲突，不依赖扫描顺序选赢家。旧基线的迟到副本不能覆盖更新的 head。

对于冲突提供「采用平台版本」「采用此副本并发布」「另存为新技能」「手动合并」；任何选择前保存双方完整快照，并要求 head/observed hash 仍与预览一致。初期不做自动文本合并，尤其不自动合并二进制。

watcher 只负责标记 dirty 和调度；按技能做可配置 debounce 和稳定快照检测，结合启动/定期增量检查与手动 reconcile 兜底。自写事件用 operation/revision/hash 识别，不能只用全局静默时间窗丢弃事件。技能写入期间若内容仍在变化则延后，不发布半包。

## 7. 一致性、写盘与恢复

1. DB 中一次事务写入 revision、head CAS 和操作队列；附件替换、绑定批量修改也使用事务。过期编辑返回 409，不采用最后写入者覆盖。
2. 队列按 skill 和规范化物理 target 串行；多进程用 DB lease/代次和文件侧协作锁，不能只用单进程内存锁。运行前核对任务是否已过期。
3. 写盘前复验目标归属和观察 hash；同卷 staging 写完整包并校验，再以可恢复的 backup/swap 流程切换。不能宣称目录替换在所有平台都单步原子。
4. POSIX 和 Windows 分别实现 rename/文件占用恢复路径；任一步失败都保留可恢复旧包。交换期间记录操作阶段，启动后按阶段补偿或收敛，禁止无条件删备份。
5. 文件成功与 profile 配置成功分别记录；配置读改写保留其他字段和用户 disabled 项。共享 profile 的变更在同一目标锁下串行。
6. 单个目标失败不回滚已保存的 catalog，也不把所有目标显示为成功；保留失败目标和重试入口。离线/SSH 目标显示 pending 或 unsupported，使用远端 adapter 前不能假报成功。
7. 幂等重试先检查已落盘内容；applied revision 只在完整写盘成功后推进。进程在写盘后、DB 更新前退出时，重启可通过 marker/hash 恢复结果。
8. 清理只针对经证明属于平台的具体目标；路径验证覆盖绝对路径、盘符/UNC、`..`、重解析点、symlink、源目标重叠、大小写碰撞和 Windows 保留名。拒绝越界链接；不自动删除外部目录。

原首期 Copy-only 决定已被用户确认的双模式合同替代：兼容的本地目标默认优先 Symlink，显式支持 Copy；Windows 链接/junction 不可用时按配置降级并记录实际模式。Symlink 使用共享可编辑目录，不冒充隔离副本或 per-turn 不可变快照。

## 8. Runtime adapter 与调用边界

统一能力接口承担 `discoverRoots`、`observe`、`prepare/deploy`、`disable/undeploy` 和 `refreshPolicy`，协调核心不硬编码所有 runtime 的目录。

| 轨道 | 交付策略 |
| --- | --- |
| Hermes，包括 default | 继续 profile 原生 skills 目录及 config disabled 机制，增加部署身份、dirty 检查和加载状态；不让平台接管插件/外部目录 |
| Claude Code / Codex | 优先使用经实际 CLI 验证的项目/会话级原生能力入口；完整交付文件包，agent/workspace/run 的物理范围必须明确 |
| Cursor / OpenCode / Kimi / 其他 | 复用同一合同，逐 runtime 声明支持目录、隔离能力和刷新要求；不支持的能力显式降级 |
| SSH Hermes | 经远端文件 adapter 观察/交付并记录 host；没有可用 adapter 时不回退成本地写盘 |

重要限制：单个 workspace 中固定的 `.claude/skills` 等目录本身不能隔离多个 agent。若 CLI 支持额外发现目录/会话级配置，使用它；若不支持，就必须显示 workspace-shared 或 scope conflict，不能把 `.agorax/.../agent-id/` 写出来便假定 CLI 会扫描，也不能改 cwd 破坏真实 workspace。

在共同的 runtime 启动/输入准备边界做能力准备，不只在 UI API 中做。覆盖新建、resume、恢复、群聊、Swarm；不允许调用者绕过。实际边界由实施时对启动调用点的审计确定。

原生加载通过真实 CLI 验证后再退役该 runtime 的全文 prompt 注入。过渡期仅给能力确实不支持的 adapter 保留有大小预算的注入，并报告 `prompt-only`；不要同一技能原生加载和全文注入双重生效。Composer 传 skillId/明确选择，未知 `/foo` 保留为用户文本，多行 prompt 不因 token 重组而丢失格式。

## 9. API 与界面方案

复用现有 catalog/binding API；新增能力由同一 application service 实现，禁止 PATCH、seed、CLI 各写一套同步逻辑。

- 更新请求接受 `expectedRevision`，响应区分 `savedRevision` 与 `operationId/deployments`；保存成功与全部同步成功分别展示。
- 增加 `scan/preview`：只读返回 candidate、来源、同名差异和部署问题，替代“扫描即无条件 upsert”。首次 GET 不再触发写盘或接管，初始化迁移单独执行。
- 增加 reconcile/status：支持 skill、agent、workspace 范围、dry-run、幂等键和逐目标结果；手动同步调用相同队列。
- 增加 adopt/publish-local：显式接管现有技能或发布本地修改，提交预览的 hash/revision，重检后执行。
- 增加 source check/update、revision history/restore、conflict resolve；source 更新与 agent 本地编辑走同一个冲突判断。
- 旧 profile toggle 遇到平台拥有的技能时转入绑定服务；外部技能只改外部状态并标明不属于平台。旧 seed endpoint 保留兼容壳，但不能继续无差别覆盖。

列表与详情分别展示「已绑定」「已部署版本」「runtime 已发现/待重启」；细分 `in-sync/pending/local-modified/conflict/missing/error/external-visible/unsupported`，不把绿色 enabled 当同步成功。

详情页增加完整文件树、文本编辑/预览、二进制下载、来源、版本历史和 agent/workspace 部署矩阵。同步前预览新增/修改/删除及受影响目标，冲突按目标处理。批量操作返回逐项结果，不因最后一个失败隐藏前面已完成的变更。

同步事件通过现有可用的事件通道传播，或短轮询操作状态；统一 Query key factory，同时失效 catalog/detail/agent bindings/Composer/capabilities，避免各处手写不匹配的 key。

## 10. 导入与上游更新

- 使用统一文件包读取器，FS/ZIP/GitHub/Git/ClawHub 输出同一 bytes manifest；frontmatter 使用现有 YAML 库解析。
- GitHub 获取指定 ref 的完整子树，保留 scripts/references/assets/templates；分支不存在应明确报错，不静默改用默认分支。记录解析后的 commit，避免一次导入混合多个远端版本。
- raw SKILL.md 只包含单文件时明确显示不完整包来源，不假称包含附件；多技能仓库/归档先列候选供选择，不随意取最短路径那一个。
- 大小、文件数、解压后总量、单项解压比和请求时长在读取时执行预算。超限或必需文件失败应整体拒绝/显示不完整，不静默丢文件后报成功。
- 二进制按原始字节保存，POSIX 可执行标志进入 manifest；Windows 保留逻辑标志，但不假装执行 chmod 即完成等价行为。
- URL 和重定向每跳校验目的地，按部署策略限制内网/loopback/链路本地访问；ZIP 路径和 symlink 复用落盘边界校验。
- 上游 check 只报告可更新及 diff，update 生成新 revision 并协调；有本地编辑先冲突，不 remove-and-reinstall，保留 skillId 与绑定。

## 11. 迁移与分期

| 阶段 | 交付内容 | 完成条件 |
| --- | --- | --- |
| P0 止损 | 暂停破坏性自动覆盖；扫描改为候选/预览；同名冲突可见；DB 多语句事务、部署结果和 Composer 失效补齐 | 本地编辑不再被无关 bind/toggle/scan 删除，外部目录跳过不再冒充成功 |
| P1 同机闭环 | revision/hash/deployments、三方协调、dirty 发布、持久队列、恢复、Hermes/default 和冲突 UI | A 编辑后无冲突的 B/C 收敛；冲突不丢文件，失败可重试 |
| P2 双轨等价 | managed adapter 原生包交付、workspace/共享目录约束、所有运行入口、完整导入和 source 更新 | Hermes + managed 的实际运行读取正确版本，禁用/重启限制可见 |
| P3 跨设备与增强 | 可选 Git 同步、导出备份/恢复、CLI、标签/预设和审计导出 | 设备离线冲突可恢复，机器路径和密钥不进入共享数据 |

P0 的暂停覆盖会暂时保留旧副本，这是明确的待同步状态，不应作为完成整个修复的终点。P1 和 P2 都完成才满足产品默认的 Hermes/managed 双轨合同。

迁移步骤：

1. 对 catalog 和每个已知目标做只读盘点与可恢复快照；不可读目录标 unknown，保持不动。不要先执行现有 materialize。
2. 将现有 DB 内容转换为 revision 1；保留 skillId 和绑定、enabled。旧内容列只作为迁移输入，不双向维持。
3. 有旧 marker 且内容等于 revision 1 的目录可建立可信基线；不同的保留两份并进入迁移冲突。旧 marker 只有 `1`，不足以证明内容是可覆盖的。
4. 无 marker 的目录仅登记 external candidate；需要用户选择关联、接管或 fork。统一规范化 name 后再建立映射，保留每个来源候选。
5. 先 dry-run 输出影响清单，再按可恢复批次启用；保留 DB 备份与目标快照，避免 schema 回退只恢复 DB 却遗留新文件。
6. 更新 [platform-skills.md](platform-skills.md)、runtime 对应合同与 [FUTURE-FEATURES.md](../FUTURE-FEATURES.md)。backlog 提到的 `docs/managed-agent-daemon-mapping.md` 当前不存在，实施前应修正到实际拥有者文档，不能继续保留失效引用。

实施规模暂估为 4 个独立迭代：P0 约 2-3 人日，P1 约 5-8 人日，P2 约 5-10 人日，P3 另行估算。估算不含未知 CLI 能力或 SSH 传输开发，需在 adapter 小范围验证后校准。

## 12. 验收与测试矩阵

下面是实施后的验收要求，不是本轮已执行的测试记录。

| 场景 | 必须证明的结果 |
| --- | --- |
| 平台编辑 | 所有绑定且可交付的目标达到同一 revision；失败目标单独报告 |
| A 本地改 SKILL.md/附件 | 单写者自动发布一次，B/C 收敛，无需重新 bind；支持新增、删除和重命名文件 |
| A/B 同时改 | 相同内容去重；不同内容保留双方并冲突，不依赖扫描顺序 |
| 上游更新遇到本地编辑 | 不能静默覆盖，解决前保留基线与双方快照 |
| 重复 seed/reconcile | 幂等、不复活显式解绑、不覆盖平台编辑、不重启活动 turn |
| 新绑定碰到外部同名目录 | 显示真实 conflict/external 状态，文件原样保留 |
| 禁用、解绑、删除、rename | dirty 副本得到保全；外部目录不删；默认 agent 与 disabled 项语义稳定 |
| 包完整性 | GitHub 子目录、PNG/PDF/模板、脚本 executable、YAML 多行字段都能往返；超限不半成功 |
| 部分失败与崩溃 | DB commit、staging、backup rename、文件切换、applied 更新各阶段故障后可恢复，重复重试无额外破坏 |
| 并发 | 两个 API 编辑 CAS 冲突；两进程争用 target；扫描期间外部改动不会被旧快照覆盖 |
| 作用域 | 两 workspace、同 runtime 两 agent、共享 profile/root、default、orphan 与 SSH 归属准确，无隐式跨作用域绑定 |
| 运行时 | Hermes/Claude/Codex 真实发现并使用文件；resume/群聊/Swarm 无绕过；需要新会话时明确显示 |
| Windows/POSIX | CRLF 字节身份、大小写冲突、保留名、链接/junction、无 symlink 权限、占用文件、跨卷 staging 均按合同失败或降级 |
| UI | 保存与同步状态分开；Composer/capabilities 及时更新；移动/窄屏冲突操作与逐目标重试可用 |
| 跨设备，P3 | 同 skill 重命名+编辑、离线双编辑、删除+编辑、恢复快照、断网重试不丢内容 |

优先在已有 store/scan/bundle/prompt 测试旁补回归；新增 coordinator/adapter 测试必须直接调用真实拥有逻辑，不能复制生产循环。文件系统与 DB 集成使用隔离临时目录。真实 CLI 验收使用隔离 home/workspace 和明确授权的 runtime，不触碰现有个人技能。

首个关键回归：准备一个 skill，部署到 A/B，修改 A，再 reconcile；断言 catalog 产生新 revision、B 完整包一致、A 编辑保留。第二个回归：A dirty 后仅 toggle 另一个 skill，断言 A 不被改写。它们应先在旧实现上失败，再由新机制通过。

总体完成标准：不仅是 UI 看到绑定，而是「可定位的技能身份、可追踪的版本、实际运行可用、冲突不丢数据、失败可恢复」同时成立。