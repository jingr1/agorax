# Platform Skills

Workspace-scoped skill catalog with Multica-style agent bindings. One skill
row, many agents — reuse without copying content.

## Model

| Table | Role |
| --- | --- |
| `platform_skills` | Catalog entry (`name`, `description`, `content`, `origin_json`) |
| `platform_skill_files` | Supporting files under a skill |
| `agent_skills` | `(agent_id, skill_id, enabled)` binding |

`agent_id` is the registry id from `agents.yaml` (Hermes workers and managed
runtimes such as `cc-impl` / `codex-impl`).

## Semantics

- **Catalog**: create / import / edit / delete on `/skills` (platform UI).
- **Bind**: assign a catalog skill to any agent; binding is permanent until
  unbound.
- **Enable**: `enabled=false` keeps the binding but hides the skill from
  Composer and runtime injection.
- **Composer `/`**: lists only the current agent's **enabled** bindings;
  selecting inserts `/{name}` for **this turn** (does not change bindings).
- **Hermes**: bind/toggle materializes marked trees under
  `~/.hermes/profiles/<profile>/skills/` and updates `skills.disabled`.
- **Managed**: activate injects all enabled skills (or selected `/name` full
  content); later turns inject selected `/name` content via
  `buildTurnSkillInjection`. Does not write `~/.codex/skills` or
  `~/.claude/skills`.

## Seed / sync

`POST /api/platform-skills/seed` (also runs once on first catalog GET) **recursively
scans** on-disk skills trees the same way Hermes WebUI does
(`iter_skill_index_files` / `rglob SKILL.md`):

- flat `skills/<name>/SKILL.md`
- nested `skills/<cat>/…/<name>/SKILL.md` (any depth, e.g. `mlops/research/dspy`)
- Hermes profile homes, repo `skills/`, `plugins/*/skills`, and `skills.external_dirs`
- **Managed agent homes** (managed-agent-aligned): `~/.claude/skills`, `~/.codex/skills`
  (+ `.system`), `~/.cursor/skills`, `~/.config/opencode/skills`, `~/.agents/skills`,
  plus project `.claude/.codex/.cursor/.opencode/.agents/skills` under the repo

Then upserts into the platform catalog and **auto-binds** each registry agent
(including declared **`default`**, home `~/.hermes` via `resolveProfileHermesHome`,
plus any remaining orphan Hermes profiles) to skills found on that agent's own
runtime roots (Hermes profile `skills/`, managed homes such as `~/.codex/skills` /
`~/.cursor/skills`), plus any names listed under `agents.yaml` `skills:`.
Shared repo `skills/` dumps stay catalog-only unless they also appear under an
agent's own roots. Binding is idempotent (`ON CONFLICT DO NOTHING`) and does
not re-enable a user-disabled row.

The Skills UI 「同步本地 skills」 button calls seed with **`materialize: false`**
so sync does not rewrite Hermes profile skill trees. Bind / toggle still
materializes; materialize never overwrites a skill directory that lacks the
`.agorax-platform-skill` marker.

`agents.yaml` `skills:` lists are **not** the catalog source of truth — they only
drive default bindings for declared agents.

## API

- `GET/POST /api/platform-skills`
- `GET/PATCH/DELETE /api/platform-skills/:id`
- `POST /api/platform-skills/seed`
- `POST /api/platform-skills/import` — `{ url }` | `{ files: [{ path, content }] }` | multipart `file` (.zip / .skill)
- `GET/POST /api/agents/:agentId/local-skills` — list / promote agent-local FS skills into catalog
- `GET/PUT/POST /api/agents/:agentId/skills`
- `PATCH/DELETE /api/agents/:agentId/skills/:skillId`
- `GET /api/agents/:agentId/skills/composer?includeContent=1`

## Create methods (Skills UI)

Matches Multica’s chooser, with runtime-copy renamed:

1. **手动创建** — blank `SKILL.md`
2. **从本地导入** — folder with `SKILL.md`, or `.skill` / `.zip`
3. **从 URL 导入** — ClawHub / Skills.sh / GitHub / raw `SKILL.md`
4. **从 Agent 已有的 skill 复制** — promote skills already on an agent’s local FS
   (Hermes profile `skills/`, plus managed homes for Claude/Codex/Cursor/OpenCode/Kimi);
   skips platform-managed and already-catalogued rows

