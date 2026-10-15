# Mission / Task domain model

> Agorax keeps a **two-level** work model (**Mission → Task**). Multica
> IssueSurface UX is borrowed for the Mission list; Symphony’s schedulable unit
> maps to **Task** (assignment), not Mission.
>
> Project 合同见 [`mission-project-domain.md`](mission-project-domain.md)。
>
> **Kanban cards are not part of this domain.** List / detail / delete are
> mission-keyed (`missionId`).
>
> **Status = board column**（对齐 Multica）：单一枚举
> `todo | ready | running | review | blocked | done | cancelled`。
> `mission.state` 由 assignments 推导；人工拖拽写 `boardLane`（同枚举 pin），
> 列表/看板有效列 = `boardLane ?? state`。

## Entities

| Layer | Agorax | Multica analogue | Symphony analogue |
|-------|--------|------------------|-------------------|
| Target repo (optional) | **Project** (`projects.yaml`) | Project（同名不同义） | — |
| User list entity | **Mission** | Issue | — |
| Schedulable unit | **Task** (`SwarmMissionAssignment`) | staged sub-issue / AgentTask | **Issue** |
| Collaboration | optional group `roomId` | squad assignee | — |

### Project（摘要）

- 控制面声明的 **目标 Git 仓库**（`id` / 绝对 `repo` / `worktreeRoot` / `selfHosted` …）
- Mission 可选挂 `projectId`；`workspaceMode` 由 pipeline 模板决定（`canonical` | `worktree`）
- **不是** Multica 协作空间；无 project 时 mission 仍可跑，只是没有声明的 repo/worktree 锚点

### Mission

- Goal container with `executionMode: pipeline | assignee`
- Persists user **spec** + **acceptanceCriteria** (editable after create)
- **Goal launch (UI):** Create Mission → Goal → assignee `orchestrator` + auto-dispatch; orchestrator must `POST /api/swarm-dispatch` with the same `missionId` to spawn specialist Tasks (replaces Conductor)
- **pipeline**: instantiate stages → Tasks; **auto-dispatch**; do **not** auto-create a room
- **assignee + agent**: single Task, auto-dispatch
- **assignee + chat_group**: bind existing room; no auto-decompose
- Room: created only via manual «Create room» (`ensureRoomForMission` → writes `roomId`)
- Optional `projectId` — 详见 project 合同
- Primary key: `mission.id`（API / UI 一律用 `missionId`）

### Task

Fields include Symphony-aligned stubs:

- `id` — assignment id（运行时 `taskId`）
- `createdByWorkerId` — who decomposed (e.g. `system:pipeline`)
- `dispatchable` — eligibility for automated dispatch
- `externalRef` — optional tracker identity
- `workspacePath` — per-task cwd snapshot

Runtime stub: `GET /api/missions/:missionId/tasks/:taskId/runtime`

## UI rules

- MissionSurface modes: board / list / swimlane (**no Gantt**；table 并入 list）
- List rows are Missions only（按 lane 分组；含 assignee / pipeline / tasks）；Tasks appear in Mission detail table
- `/tasks` redirects to `/missions`
- Board drag writes `mission.boardLane`（= status pin）via `PATCH /api/missions/:id`（也可传 `status`）
- Properties 只展示一项 **Status**（effective：`boardLane ?? state`）

## Pipeline contract vs Symphony WORKFLOW.md

| Symphony WORKFLOW.md | Agorax |
|----------------------|--------|
| YAML front matter + Markdown prompt | `pipelines.yaml` + `pipelines/<id>/stages/<key>.md` |
| `issue` / `attempt` template vars | `mission` / `task` / `stage` / `attempt` / `upstream` |
| tracker poll as work source | Mission-decomposed Tasks (internal) |
| claim / retry / stall | `task-scheduler.ts` on top of `dispatchReadyAssignments` |

Skills keep `SKILL.md` YAML front matter; optional `metadata.hermes.pipeline_stages` and `outcomes` bind stages ↔ skills via `skillRefs`.

## APIs

- `GET/POST /api/missions` — primary（GET 直接列 `listSwarmMissions`）
- `GET/POST/PATCH/DELETE /api/missions/:id` — detail / start / patch / delete（`:id` = missionId）
- `GET /api/missions/:id/tasks/:taskId/runtime` — Task runtime stub
- `GET /api/projects` — projects.yaml declarations (target repos)
- `GET/POST /api/tasks` — compatibility alias

### Mission detail UI

- Timeline renders event `message` (+ worker); consecutive `continuation` rows fold
- Header shows active worker via `currentAssignee` and current stage
- Task Summary is a short line with expand-to-full brief
- Properties: editable priority / labels / project / assignee (assignee mode);
  status / pipeline / room remain informational（status 为单一生命周期字段）
- Detail 主栏可编辑 **title / spec / acceptanceCriteria**（PATCH；变更 bump `specVersion`，既有 briefs 标 stale，不自动重生成）
- Spec 支持引用 workspace 文件路径：`Attach path…` 或拖入 `application/x-hermes-workspace-file`，插入为 `` `path` `` 纯文本
- Create Mission can optionally set `projectId`
- Delete：detail 头栏 Confirm → `DELETE /api/missions/:id`
