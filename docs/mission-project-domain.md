# Mission ↔ Project domain contract

> Agorax **Project** = 控制面在 `projects.yaml` 中声明的 **目标 Git 仓库**（agent 可改代码/产物的 cwd 真相源）。  
> **Mission** = 用户可见的目标容器（见 `[mission-task-domain.md](mission-task-domain.md)`）。二者 **可选绑定**；`workspaceMode` 由 pipeline 模板决定，不由 Project 单独决定。

---

## 1. Project 是什么 

- **声明式 registry entry**：`GET /api/projects` 与 `loadProjectsFile()` 均来自仓库根 `projects.yaml`（`version` + `projects[]`）。
- **字段契约**（每条 `ProjectDeclaration`）：
  - `id` — 稳定引用键（Mission 存 `projectId`）
  - `repo` — **绝对路径**，必须是有效 Git 仓库
  - `defaultBranch`, `worktreeRoot`（绝对路径，且 **在 repo 外**）, `setup[]`, `maxConcurrentWorktrees`, `gitRemote`, `selfHosted`, `remotes[]`（按 host 的远端 repo/worktreeRoot/setup）
- **运行时校验**：无 `projects.yaml` 或校验失败 → 无法解析 project；**禁止**用 `process.cwd()` 隐式当 target repo。
- **自宿主 opt-in**：若 `repo` 指向控制面仓库（hermes-workspace 自身），必须 `selfHosted: true`，否则加载失败。

---



## 2. Mission → Project（可选绑定）


| 字段              | 位置      | 含义                                                                                           |
| --------------- | ------- | -------------------------------------------------------------------------------------------- |
| `projectId`     | Mission | 可选；指向 `projects.yaml` 中某 `id`                                                                |
| `workspaceMode` | Mission | `canonical` | `worktree`；**pipeline 创建时**从 `pipelines.yaml` 模板拷贝；assignee 模式创建固定 `canonical` |


**规则**

- Mission **可以**无 `projectId`：仅 metadata / swimlane 分组；agent cwd 不自动指向任何 declared repo。
- 有 `projectId` 时 create/patch 必须 `getProject(id)` 成功，否则 400 / throw。
- **Binding 不反向**：Project 不枚举其 missions；并发 worktree 上限由 `maxConcurrentWorktrees` + git-ops  enforcement。
- `workspaceMode` **不**在 Mission create 表单里单独选（由所选 pipeline 决定）。

---



## 3. `workspaceMode` 与 Project 的交互

Pipeline 模板级二选一（`pipeline-templates.ts` 加载期校验）：


| `workspaceMode` | 有效 cwd（有 `projectId`）                             | worktree 创建时机                                                                                                |
| --------------- | ------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| `canonical`     | `project.repo`（共享 canonical checkout）             | 无 per-mission worktree                                                                                       |
| `worktree`      | `<worktreeRoot>/<missionId>/…`（`localGitContext`） | `createMission`：template=worktree **且** 有 project → `ensureMissionWorktree`；`ensureRoomForMission` 也会 ensure |


**worktree 模式约束**

- 模板中 stage 若绑定 **本机 Hermes tmux worker**（`runtime: hermes` 且非 `execution: ssh`）→ **加载 pipeline 即报错**（tmux 无法 per-mission 切 cwd）。
- 允许：managed CLI adapter、`execution: ssh` 的 Hermes agent、capability 路由（如 `requires: [gpu]` → `gpuserver`）。
- `GET /api/git/diff`：canonical mission 返回 409 `workspace_mode_unsupported`；worktree 用 assignment `baseRef..head` 语义。

**无 project 的 worktree pipeline**：`workspaceMode` 仍写入 mission，但 **不会** `ensureMissionWorktree`（无 repo 锚点）；群聊/派发 cwd 可能为 null，直到补绑 project。

---



## 4. 生命周期



### Create (`createMission`)

1. 可选 `projectId` → `getProject` 校验。
2. **pipeline**：读 template → 设 `mission.workspaceMode = template.workspaceMode`；若 `worktree && project` → `ensureMissionWorktree`，首 assignment 写 `baseRef` / `workspacePath`。
3. **assignee**（agent 或 chat_group）：`workspaceMode` 恒 `canonical`；chat_group 只绑 room，不自动 worktree。
4. 返回 payload 含 `projectId`, `workspaceMode`, `worktreePath`（若有）。



### Run

- Task dispatch / advance：worktree mission 在 mission worktree cwd 上跑；canonical 在 `project.repo`（若已绑 project）。
- 群聊 **任务型** room：`resolveRoomCwd(room)` = 显式 `workspacePath` **else** `deriveMissionWorkspacePath(missionId)`（worktree → worktree path，否则 → `project.repo`）。每 turn drive **算一次**，不改 Hermes profile 全局 workspace。
- 服务器 **禁止**从某 project 的 `worktreeRoot` 内启动（防 `deleteMission` release 删掉运行中树）。



### Delete (`deleteMission`)

1. `cancelSwarmMission` → 删 mission 记录。
2. 若 `projectId && workspaceMode === 'worktree'` → `releaseMissionWorktree(project, missionId)`（best-effort；失败打 warn）。

Patch：`projectId` 可改（校验 known id）；**不**自动迁移已有 worktree（改绑属运维/产品边界，文档层记：worktree 与 create 时 project 强耦合）。

---



## 5. UX 含义

- **Mission 列表**：支持按 `projectId` swimlane；无 project 归入「未分类」类泳道。列表实体是 Mission（`listSwarmMissions`），**不再**经 kanban card 投影。
- **Create Mission**：可选选 Project；pipeline 选择隐含 workspace 语义（当前 shipped pipelines 均为 `canonical`；worktree pipeline 需 UI 提示需选 project + 非本地 tmux worker）。
- **Mission 详情 Properties**：`project` 可编辑；`workspaceMode` / pipeline / lane 多为只读信息字段。
- **群聊**：Ad-hoc room 自管 `workspacePath`；From mission 的 room cwd 只读派生，worktree 模式展示/依赖 mission 侧 worktree 已 ensure。
- **Git 面板 / diff**：仅 worktree + 有 git 上下文时有意义；canonical 勿冒充 stage diff。

---



## 6. Agorax Project vs Multica Project


| 维度    | Agorax `Project`                      | Multica `Project`          |
| ----- | ------------------------------------- | -------------------------- |
| 存储    | 控制面 `projects.yaml`                   | 服务端 DB，workspace 作用域       |
| 身份    | `id` + 本机/远端 **文件系统路径**               | UUID + slug，权限与成员          |
| 绑定对象  | Mission（可选 `projectId`）               | Issue、视图、Gantt、inbox 等     |
| 工作区   | `repo` / per-mission **git worktree** | 无内置 git worktree 模型        |
| API   | `GET /api/projects`                   | Multica REST `/projects` … |
| 列表 UX | Mission swimlane 维度                   | IssueSurface project scope |


**集成原则**：跨产品链接时用 **显式字段**（如 Mission `externalRef` / tracker id），不要把 Multica project slug 写进 Agorax `projectId`，除非运维刻意对齐命名。

---



## 相关实现索引


| Concern                  | Path                                                                      |
| ------------------------ | ------------------------------------------------------------------------- |
| projects.yaml 加载/校验      | `src/server/task-pipeline/projects.ts`                                    |
| create/delete + worktree | `src/server/task-pipeline/task-service.ts`, `src/server/git-ops.ts`       |
| pipeline workspaceMode   | `pipelines.yaml`, `src/server/task-pipeline/pipeline-templates.ts`        |
| 群聊 cwd                   | `src/server/group-chat/resolve-room-cwd.ts`, `ensure-room-for-mission.ts` |
| Mission/Task 总览          | `[mission-task-domain.md](mission-task-domain.md)`                        |


