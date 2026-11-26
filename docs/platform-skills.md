# Platform Skills

Workspace-scoped skill catalog with agent bindings. The catalog owns versioned
content; runtime file trees are observed deployment copies.

## Model

| Table | Role |
| --- | --- |
| `platform_skills` | Catalog entry (`name`, `description`, `content`, `origin_json`) |
| `platform_skill_files` | Supporting files under a skill |
| `agent_skills` | `(agent_id, skill_id, enabled)` binding |
| `skill_revisions` | Immutable complete-package snapshots and parent revision |
| `skill_deployments` | Actual path, observed hash, delivery status and applied revision per agent |
| `skill_sync_operations` | Durable operation history and per-target results |
| `skill_sync_leases` | Coordination lease shared by server processes |
| `agent_skill_exclusions` | Explicit unbinding intent, preserved during discovery |

Migration 12 adds the version and synchronization tables. Existing content and
file rows remain the transactional head projection; every content mutation
records its revision in the same transaction. The first edit or reconciliation
upgrades a legacy entry. Revision snapshots retain binary attachments as base64
and logical executable flags; text-only API clients remain compatible.

Migration 13 adds `platform_skills.deployment_mode` (default `symlink`),
`allow_copy_fallback` (default enabled), and the actual mode/source path on each
deployment. Changing policy uses the same revision check as content editing.

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
  `~/.hermes/profiles/<profile>/skills/` and updates `skills.disabled`;
  `default` uses `~/.hermes/skills/`.
- **Managed**: bound packages are synchronized to
  `<collab.db directory>/platform-skills/managed/<agent-id>/<skill-name>/`.
  The activate catalog provides the readable `SKILL.md` path; selected `/name`
  turns include instructions and package paths, without dumping every attachment
  into the prompt. This is **on-demand loading**, not native CLI discovery.
  User-global `.claude/skills` and `.codex/skills` are never overwritten.
- **External directories**: an existing unmarked skill is reported as
  `external-visible`. The detail page can explicitly adopt its content or use
  the catalog version; either action snapshots the old copy first.
- **Disabled/removed**: platform binding state is not a security boundary and
  cannot revoke instructions already loaded in an active session. Runtime-native
  skills installed outside Agorax remain outside platform ownership.
- **SSH**: reported as unsupported for filesystem delivery; no local write is
  presented as a successful remote deployment.

## File Browser

The skill detail page displays the complete package, including `scripts/`,
`references/`, `templates/`, and `assets/`. Directories expand in place. Markdown
supports preview/source modes; all text files can be edited. Draft files can be
added or removed and are saved with `SKILL.md` as one revision. Binary attachments
are downloadable without decoding them as text. Cancel discards the entire draft.

### `.agorax-skill-ignore`

Optional gitignore-like file at the skill root. Matched paths stay on disk for
runtime (Hermes / local scripts) but are **omitted** from Agorax package read,
hash, and watcher fingerprints. Use this for fixed codegen trees that must not
enter the 512-file catalog sync (for example `references/generated/**`).

If a package still exceeds size limits after ignores, the watcher **skips sync
for that skill** (one warning, no 30s retry loop) rather than flooding logs.

The editor pins the revision it opened. A concurrent change rejects the save with
409 rather than overwriting it. The page also shows per-agent deployment status,
manual synchronization, explicit conflict actions, and restorable revision history.

## Bidirectional Synchronization

The control-plane bootstrap starts synchronization, independently of opening a
Skills page. Authenticated catalog/detail operations also idempotently ensure it
is running after a partial dev-server/HMR restart. Shutdown/HMR closes every
watcher and timer. Synchronization uses:

- Recursive filesystem events for the central library and deployment roots.
- A 500 ms per-skill debounce, followed by stable content verification. A changing
  package is checked again after 100 ms rather than published halfway through a save.
- A three-second watch-set refresh that discovers new targets, checks directory
  identity/configuration revisions, and replaces stale watchers. An edit immediately
  after a mode switch can therefore take a watch-set refresh to be observed.
- A 30-second periodic check for missed events and unavailable native watchers.
- Fingerprints after reconciliation to suppress self-write echoes without a global
  mute window. Per-directory fingerprint failures are recorded as stable error
  tokens rather than throwing; settled permanent deployment errors wait for a
  watcher/layout change instead of re-enqueueing every fallback tick. Pending
  targets still back off. Manual sync is immediate.
- Package reads and catalog hashes skip junk directories such as `node_modules`,
  `.git`, and virtualenvs (same exclusion set as disk discovery). Sync startup
  prunes any legacy excluded attachments already stored in the catalog.
- Unmanaged paths that collide with a catalog name (for example a category
  folder like `skills/github/` without a root `SKILL.md`) stay
  `external-visible`; sync does not escalate them to hard errors.
- Sync bootstraps asynchronously after control-plane start and drains the first
  reconcile pass through an idle queue (one skill at a time) so Vite readiness
  and API handlers stay responsive.
- Watcher fingerprints use package file mtime/size (skipping junk dirs) rather
  than reading every file body. Refresh loads watch targets in one readonly
  SQLite pass.
- `GET /api/platform-skills` returns the existing catalog immediately when it is
  non-empty; disk discovery continues in the background instead of blocking the
  request (~tens of seconds on large Hermes homes).

### Deployment Modes

Each skill has one editable central tree at
`<collab.db directory>/platform-skills/library/<skill-id>/`. This path is stable
across display-name changes. It is separate from the immutable DB revision
snapshots; a filesystem edit becomes a revision only after stable reconciliation.

**Symlink is preferred by default.** Hermes and managed deployment paths point
to the central tree. An edit through A is immediately visible when B reads the
same file, before catalog bookkeeping finishes. Windows tries a directory link,
then a junction. If neither is supported, the configured Copy fallback is reported
with its reason. Turning fallback off reports an error and preserves the previous
deployment instead of silently copying.

**Copy is explicitly selectable** in the detail editor or API. Targets are
independent complete packages, retaining the existing baseline/conflict checks.
Mode changes preflight ownership and content before replacing anything. Existing
clean platform copies migrate on reconciliation; dirty copies are published or
reported as conflicts first. External directories/foreign links are never adopted
merely because their names match. Unbinding removes only owned links/copies,
never the shared central tree. Broken owned links and interrupted mode swaps can
be recovered without following or deleting an external link target.

The UI shows both the preferred mode and each agent's actual mode. The shared
central tree has ordinary shared-file semantics: simultaneous out-of-band writers
can overwrite one another. Platform saves retain revision CAS; callers needing
independent edits should choose Copy. This is not a new per-turn snapshot or
runtime hot-reload mechanism.

For every platform-owned deployment, the marker records skill identity and a
baseline package hash. Reconciliation observes all bound copies before choosing:

- One local edit with an unchanged catalog baseline is published and distributed.
- Identical concurrent edits publish once; divergent edits preserve each copy and
  report conflict. A changed catalog does not overwrite a dirty deployment.
- An unknown legacy marker differing from the catalog requires explicit resolution.
- A missing deployment is repairable, not interpreted as global deletion.
- Renaming a clean deployment moves it; dirty old directories are preserved.
- Unbinding deletes only a clean owned copy. Unpublished edits are never silently
  removed. Legacy unidentifiable directories remain untouched.

Writes use same-parent staging and a recoverable backup/swap. Interrupted swaps
recover the old directory or retain the backup when ownership/content is unclear.
File-level paths reject traversal, absolute paths, Windows reserved names,
case-insensitive collisions, nested symbolic links, and file/directory conflicts.
Only deployment-root links whose destination is this skill's central directory
are followed by scanning/synchronization; external links are preserved.
Executable metadata survives Windows copy deployments in the marker manifest.

Deployment rows distinguish `in-sync`, `conflict`, `external-visible`, `error`,
`pending`, `prompt-only`, and `unsupported`. An in-sync package does not prove a
running runtime has refreshed its loaded skill list. Active turns are not restarted.

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

Then creates missing catalog entries and **auto-binds** each registry agent
(including declared **`default`**, home `~/.hermes` via `resolveProfileHermesHome`,
plus any remaining orphan Hermes profiles) to skills found on that agent's own
runtime roots (Hermes profile `skills/`, managed homes such as `~/.codex/skills` /
`~/.cursor/skills`), plus any names listed under `agents.yaml` `skills:`.
Shared repo `skills/` dumps stay catalog-only unless they also appear under an
agent's own roots. Binding is idempotent (`ON CONFLICT DO NOTHING`) and does
not re-enable a user-disabled row or resurrect an explicitly removed binding.
Existing names with different content are returned as source conflicts, not
silently overwritten. Different on-disk sources remain separate scan candidates.
Managed project roots are filtered by runtime rather than assigned to every agent.

The Skills UI 「同步本地 skills」 button performs non-overwriting discovery,
then invokes the same package reconciliation used by edit/bind/toggle. The seed
response includes source conflicts and per-target deployment results. Automatic
first-GET discovery does not immediately materialize profile trees. The marker is
`.agorax-platform-skill`; version 2 records identity, hash and executable metadata.

`agents.yaml` `skills:` lists are **not** the catalog source of truth — they only
drive default bindings for declared agents.

## API

- `GET/POST /api/platform-skills`
- `GET/PATCH/POST/DELETE /api/platform-skills/:id`
- `POST /api/platform-skills/seed`
- `POST /api/platform-skills/import` — `{ url }` | `{ files: [{ path, content }] }` | multipart `file` (.zip / .skill)
- `GET/POST /api/agents/:agentId/local-skills` — list / promote agent-local FS skills into catalog
- `GET/PUT/POST /api/agents/:agentId/skills`
- `PATCH/DELETE /api/agents/:agentId/skills/:skillId`
- `GET /api/agents/:agentId/skills/composer?includeContent=1`

Detail GET includes `deployments` and `revisions`. PATCH accepts
`expectedRevision` and complete `files` with optional `encoding: "base64"` and
`executable`, plus `deploymentMode: "symlink" | "copy"` and
`allowCopyFallback: boolean`. Deployment results include `actualMode` and
`sourcePath`, with a reason when Copy was used as fallback.
POST supports `sync`, `restore` (revisionId/expectedRevision), and
`use-catalog` / `publish-local` (agentId/expectedRevision/observedHash). Resolution
rechecks the preview hash and stores a snapshot before replacing any file.

Folder/ZIP/GitHub import preserves nested files and binary bytes. GitHub resolves
to a commit before reading the tree and downloads, without silently changing an
invalid requested branch. ZIP requires Python 3 on PATH and applies decompressed
file/count/total budgets. Oversized files are rejected instead of silently dropped.
Multi-skill archives require importing one skill directory at a time.

## Create methods (Skills UI)

Matches Multica’s chooser, with runtime-copy renamed:

1. **手动创建** — blank `SKILL.md`
2. **从本地导入** — folder with `SKILL.md`, or `.skill` / `.zip`
3. **从 URL 导入** — ClawHub / Skills.sh / GitHub / raw `SKILL.md`
4. **从 Agent 已有的 skill 复制** — promote skills already on an agent’s local FS
   (Hermes profile `skills/`, plus managed homes for Claude/Codex/Cursor/OpenCode/Kimi);
   skips platform-managed and already-catalogued rows

## Future

- Native managed discovery still requires a daemon/provider capability contract;
  isolated package delivery does not claim that contract is implemented.
- SSH delivery, workspace override policies, source check/update UI,
  revision retention/compaction, and Git-backed cross-device sync remain pending.
- Full implementation sequencing and remaining validation gates are tracked in
  [platform-skills-sync-plan.md](platform-skills-sync-plan.md).

