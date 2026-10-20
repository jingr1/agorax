# UI 中英全量覆盖 — 后续计划

> 状态：**planned**（未开工）  
> 相关：[`docs/i18n-contributing.md`](../i18n-contributing.md)、`src/lib/i18n.ts`

---

## 1. 背景

Agorax 已有轻量 i18n（`t()` + Settings → Language，`en` / `zh`）。当前约 40 个 key，**几乎只有侧栏导航真正接了 `t()`**；其余大量 screen/component 仍是硬编码英文。

机制足够支撑中英切换；缺口是文案迁入与接线，不是换框架。

---

## 2. 目标

- 用户在 Settings 切到中文后，**主产品 UI 文案基本为中文**（按钮、标题、空态、表单、toast、常用 aria-label）。
- 英文为 source of truth（`EN`）；`ZH` 与 `EN` key 集合一致（测试已有雏形，需随 key 增长保持）。
- **不**引入 i18next / ICU 等重型方案，除非后续出现复数/插值复杂度逼近现有 map 的极限。

### 明确不做（本计划范围外）

- Agent / 模型 / runtime 专有名词强制翻译
- 用户内容、日志流、多数服务端原始错误串
- 文档站 / markdown 知识库全文翻译
- 俄语等第三语言（现实现为 `en` | `zh`；`i18n-contributing.md` 里若仍提 RU，以代码为准）

---

## 3. 分阶段

### Phase A — 主路径可用中文（优先）

覆盖高频面：

- 侧栏 / 顶栏（已部分完成）
- Chat、Missions、Agents、Swarm、Settings、Group chat 常用交互
- 通用：Save / Cancel / Delete / Loading / Error / 空态

验收：上述路径在 `zh` 下无明显整页英文壳。

### Phase B — 全 UI 扫尾

- 其余 screens（Jobs、Skills、MCP、Memory、Echo Studio、Gateway 面板等）
- placeholder / title / aria-label 中面向用户的英文
- 对话框、确认框、表格列头、筛选标签

验收：Settings 切 `zh` 后，产品壳层几乎看不到硬编码英文（专有名除外）。

### Phase C — 防回归

- 约定：新 UI 字符串必须先加 `EN`/`ZH` 再 `t('…')`（见 contributing 文档）
- 可选：简单 lint / CI 检查「新增 JSX 英文文案未走 `t()`」（启发式即可，不必完美）
- 保持 `src/lib/i18n.test.ts`：各 locale key 齐全 + 抽样文案断言

---

## 4. 工作量与风险（粗估）

| 项 | 判断 |
| --- | --- |
| 架构改动 | 小（继续扩 map） |
| 工程量 | 大且机械：约 300+ `.tsx`，估计数百～一千+ key |
| Phase A | 大约几天级 |
| Phase A+B | 大约一两周量级（视扫尾严格程度） |
| 运行时性能 | 可忽略（查表）；**勿**为 i18n 加无谓 memo / context 重渲染 |

风险：

- key 爆炸导致 `i18n.ts` 单文件难维护 → 可按域拆 `i18n/nav.ts`、`i18n/chat.ts` 再聚合，仍保持同一 `t()` API。
- 带变量文案（`Delete ${name}?`）需约定简单插值（例如 `t(key, { name })`），避免字符串拼接破坏语序。

---

## 5. 建议执行顺序

1. 盘点：按 `src/screens/*` 列出未接线页面与粗略字符串量。
2. 先做 Phase A 高频面，合并、切语言手测。
3. Phase B 按目录分批 PR，避免巨型 diff。
4. Phase C 加防回归约定 / 轻量检查。

---

## 6. 开工检查清单（未来 PR 用）

- [ ] Phase A 页面全部 `t()` 化，`ZH` 齐全
- [ ] Phase B 剩余 screens 扫尾
- [ ] 插值 API（若需要）+ 测试
- [ ] `pnpm exec vitest run src/lib/i18n.test.ts` + 手测 Settings 切语言
- [ ] 更新 [`docs/i18n-contributing.md`](../i18n-contributing.md)「Current limitation」为已覆盖范围说明
