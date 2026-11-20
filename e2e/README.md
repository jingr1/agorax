# Agorax E2E Tests

This directory contains end-to-end tests for Agorax using Cucumber (BDD) and
Playwright. Cucumber describes user journeys; Playwright drives Chromium and
checks the rendered UI.

## Structure

```text
e2e/
  cucumber.config.js        Cucumber discovery, tags, and report configuration
  cucumber.soak.config.js   Opt-in endurance runner configuration
  tsconfig.json             Standalone E2E type checking
  src/
    features/
      chat/                 Send deduplication, turn ownership, and recovery
      group-chat/           SSE and POST ordering regression
    steps/                  Playwright actions and assertions
    mocks/                  Isolated chat, room, and event fixtures
    support/                Scenario context, browser lifecycle, and artifacts
  helpers/                  Existing browser helpers
  reports/                  Generated reports and failure traces (ignored)
```

Cucumber is the single E2E runner. The previous Playwright Test specs have been
migrated into features and steps; Playwright remains the browser and assertion
library.

## Prerequisites

- Node.js 22+ and the repository's pinned pnpm version
- Dependencies installed from the repository root with `pnpm install`
- Chromium installed with `pnpm exec playwright install chromium`
- A local UI server; the runner does not start or stop one

Run all commands below from the repository root, not this directory.

For a mock-only UI target on Linux/macOS:

```bash
AGORAX_AUTO_START_AGENT=false pnpm exec vite dev --host 127.0.0.1 --port 6745
```

PowerShell equivalent:

```powershell
$env:AGORAX_AUTO_START_AGENT = 'false'
pnpm exec vite dev --host 127.0.0.1 --port 6745
```

Use a free port without restarting an existing service. Tests intercept browser
API calls, but browser interception does not isolate server-side startup or SSR
code. Keep Agent auto-start disabled and do not point tests at production or
shared user data.

## Running

The default URL is `http://127.0.0.1:6734`. `BASE_URL` takes precedence over
`PLAYWRIGHT_BASE_URL`. To use the example server above:

```bash
BASE_URL=http://127.0.0.1:6745 pnpm test:e2e
BASE_URL=http://127.0.0.1:6745 pnpm test:e2e:smoke
BASE_URL=http://127.0.0.1:6745 pnpm test:e2e --tags @CHAT-TURN-001
HEADLESS=false BASE_URL=http://127.0.0.1:6745 pnpm test:e2e:smoke
```

PowerShell uses environment assignments instead of inline prefixes:

```powershell
$env:BASE_URL = 'http://127.0.0.1:6745'
$env:HEADLESS = 'false'
pnpm test:e2e:smoke
```

Check discovery and types without launching a browser:

```bash
pnpm test:e2e --dry-run
pnpm exec tsc -p e2e/tsconfig.json
```

Dry-run verifies step registration, not product behavior. A run reporting zero
scenarios is not a successful verification.

## Current Coverage

| Tag                   | Expected behavior                                                    |
| --------------------- | -------------------------------------------------------------------- |
| `@CHAT-SEND-001`      | Rapid double submission adds one user message                        |
| `@CHAT-TURN-001`      | Busy follow-up stays queued; the prior reply keeps its ownership     |
| `@CHAT-TURN-002`      | Sending preserves the prior reply and does not duplicate the user    |
| `@CHAT-DISPLAY-001`   | Equal-timestamp multi-turn history stays interleaved; no mashed bubble |
| `@CHAT-DISPLAY-002`   | Thinking… clears when reply text arrives; idle after settle          |
| `@CHAT-RECOVERY-001`  | Completed history renders once in an idle state                      |
| `@CHAT-RECOVERY-002`  | Reload removes stale waiting state for a completed session           |
| `@GROUP-SEND-001`     | SSE refresh before POST completion does not duplicate a room message |
| `@CHAT-LIFECYCLE-001` | Completed streaming reply survives reload without duplication        |
| `@CHAT-LIFECYCLE-002` | A failed send displays an error and permits a successful new send    |
| `@CHAT-LIFECYCLE-003` | Switching sessions mid-stream does not mix transcripts               |
| `@CHAT-LIFECYCLE-004` | Stopping generation permits another successful turn                  |
| `@CHAT-SOAK-001`      | Seeded same-page multi-turn chat preserves messages and drafts       |

### Workspace Pages

Run the page baseline independently with `pnpm test:e2e --tags @workspace`.
It uses the same isolated browser lifecycle and fails on uncaught page errors.

| Surface         | Browser checks                                                                                                   | Tags                                                                                 |
| --------------- | ---------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------ |
| Dashboard       | Main content and New Chat navigation                                                                             | `@PAGE-DASHBOARD-001`                                                                |
| Main navigation | Agents, Skills, MCP, Jobs, Memory, Missions, Swarm, Files, Settings, Echo Studio                                 | `@PAGE-NAVIGATION-001`                                                               |
| Legacy routes   | Operations/Profiles, Tasks/Mission Control/Conductor, Swarm2, managed settings deep link                         | `@PAGE-REDIRECT-001`                                                                 |
| Agents          | Workspace/Hermes and managed roster entries; New Agent form cancellation                                         | `@PAGE-AGENTS-001`, `@PAGE-FORMS-001`                                                |
| Skills          | Search and clear, Hermes/managed enable state after reload, detail/edit cancellation, creation chooser dismissal | `@PAGE-SEARCH-001`, `@PAGE-SKILLS-002`, `@PAGE-SKILLS-DETAIL-001`, `@PAGE-FORMS-001` |
| MCP             | Library search, Hermes/managed assignment panels, creation form cancellation                                     | `@PAGE-SEARCH-001`, `@PAGE-MCP-001`, `@PAGE-FORMS-001`                               |
| Jobs            | Search and clear, pause/reload/resume, creation form cancellation                                                | `@PAGE-SEARCH-001`, `@PAGE-JOBS-002`, `@PAGE-FORMS-001`                              |
| Files           | Workspace tree and Markdown file preview                                                                         | `@PAGE-FILES-001`                                                                    |
| Memory          | Agent memory content, Knowledge and External providers tabs                                                      | `@PAGE-MEMORY-001`, `@PAGE-MEMORY-002`                                               |
| Missions        | Page load and creation form cancellation                                                                         | `@PAGE-NAVIGATION-001`, `@PAGE-FORMS-001`                                            |
| Swarm           | Page load and workflow help open/close                                                                           | `@PAGE-NAVIGATION-001`, `@PAGE-SWARM-001`                                            |
| Settings        | Root/provider pages and no-match search                                                                          | `@PAGE-NAVIGATION-001`, `@PAGE-SETTINGS-001`                                         |
| Terminal        | Mock PTY stream and new tab creation                                                                             | `@PAGE-TERMINAL-001`                                                                 |
| Group Chat      | Empty-room state and New room entry; existing send race regression                                               | `@PAGE-GROUP-001`, `@GROUP-SEND-001`                                                 |
| Echo Studio     | Page load and required-field generation gate                                                                     | `@PAGE-NAVIGATION-001`, `@PAGE-ECHO-001`                                             |

The main workspace baseline is not full functional coverage. Creation-form
cancellation does not prove creation, update, or deletion succeeds. Real PTY
processes, live agents, login/onboarding, mobile/Electron variants, reservation
and VT Capital pages, and arbitrary user-generated pages are outside this
baseline. Skills and MCP browser fixtures do not prove on-disk materialization
or real managed adapter injection. Add those as
separate journeys rather than counting a page heading as full feature coverage.

Page fixtures are local to each scenario. State-changing checks update those
fixtures and verify refetched UI state, without touching actual files, jobs,
agent profiles, or model accounts. Capability probes are mocked explicitly;
do not accept a backend-unavailable placeholder as the normal page outcome.

### Core Journeys

| Journey | Implemented browser checks | Remaining scope |
| --- | --- | --- |
| MCP dual runtime | Passed: `@BIND-MCP-001` default/Hermes and managed add, reload, remove | Binding failures and rollback, duplicate operations, cross-agent isolation, real configuration delivery and runtime injection |
| Skills dual runtime | Passed: `@BIND-SKILL-001` add from detail, reload, remove; existing enable-state checks | Binding failures and rollback, duplicate operations, cross-agent isolation, real file materialization and provider-specific loading |
| Managed chat | Passed: `@MANAGED-CHAT-001` canonical input response, assistant reply, reload | Streamed intermediate states, cancel and resend, failure recovery, approvals and questions, consecutive turns and session switching |
| Session CRUD | `@MANAGED-SESSION-CRUD-001` authored from an empty list, not browser-verified | Complete managed verification; implement Hermes creation, rename, deletion and reload persistence |
| Group chat | Existing send ordering regression and empty-room page | Room creation and rename, member add/remove, mention dispatch, agent reply/settlement, pause/resume, human responses and room deletion |
| Agents CRUD | Both runtime roster entries and New Agent form cancellation | Create Hermes and managed agents, save configuration changes, verify reload persistence, delete agents and reject builtin deletion |

These statuses describe the last verified runs, not a fresh full-suite result.
Prioritize the remaining work in this order:

1. Session CRUD for both runtimes.
2. The complete group-chat journey.
3. Agents CRUD for both runtimes.
4. Managed chat lifecycle and failure paths.
5. Binding failure handling and cross-agent isolation, then real backend
  integration for Skill files, MCP configuration and managed launch injection.

Keep the passing binding add/reload/remove and managed send/reply/reload checks
as regressions; extend them rather than duplicating their happy paths. Browser
mocks do not verify filesystem writes, daemon behavior or Agent CLI injection.

Do not count an authored or dry-run-only scenario as verified coverage.
Run the new binding checks with `pnpm test:e2e --tags @bindings` and managed
checks with `pnpm test:e2e --tags @managed`. The runtime mock uses canonical
snapshots; it does not launch a user-installed Agent CLI.

`@smoke` selects the small baseline; `@regression` selects regression scenarios.
The default configuration excludes `@skip` and `@soak` and disables retries.
The soak runner uses its own configuration so its tag does not intersect the
default exclusion. The default endurance run uses 20 rounds and seed 12345:

```bash
BASE_URL=http://127.0.0.1:6745 pnpm test:e2e:soak
BASE_URL=http://127.0.0.1:6745 E2E_SOAK_ROUNDS=100 E2E_SEED=12345 pnpm test:e2e:soak
pnpm test:e2e:soak --dry-run
```

`E2E_SOAK_ROUNDS` accepts 1..10000; `E2E_SEED` accepts an integer. The seed
determines prompt values and whether an in-progress draft is entered. The run
checks message counts, exact replies, draft preservation, request counts, and
the unchanged document identity and transcript order. Before checking the full
transcript it expands earlier messages through the existing UI control; the
default 64-message render window is not a data-loss signal. It does not reload
the page between rounds.
This is a deterministic state endurance test, not randomized network chaos or a
memory-leak measurement. Real reconnects, multi-tab behavior, mobile layouts,
and managed-runtime protocols still need separate coverage.

If the same-page run shows two turn replies inside one assistant bubble, retain
the seed, operation log, screenshot, and trace. This is a failure of the per-turn
transcript invariant even when both reply strings remain visible. Distinguish
fixture protocol errors from product reconciliation errors before changing code;
do not replace exact counts with a generic text-presence check to make it pass.

## Reports and Debugging

Each run writes:

- `e2e/reports/cucumber.html`: readable scenario results and attachments
- `e2e/reports/cucumber.json`: machine-readable results
- `e2e/reports/artifacts/<session-id>.zip`: failed-scenario Playwright traces
- `e2e/reports/soak.html` and `soak.json`: separate endurance reports

Failed scenarios attach a screenshot, captured page errors, and recorded
operations. Uncaught page errors also fail otherwise successful scenarios.
Endurance traces discard completed chunks every 25 rounds; a failure retains
the current chunk, with the seed and operation history attached. Open a trace with:

```bash
pnpm exec playwright show-trace e2e/reports/artifacts/<session-id>.zip
```

Reports use fixed filenames and are overwritten on the next run. Archive the
relevant artifacts before rerunning when investigating an intermittent failure.
Treat screenshots and traces as potentially sensitive; do not commit them.
Vite excludes `e2e/reports/` from its file watcher so incremental HTML report
writes cannot reload the page under test. Keep that exclusion when moving reports.

## Adding Scenarios

- Describe user-visible behavior in `src/features/<domain>/*.feature`, with a
  stable case tag and suitable priority/module tags.
- Put browser actions and assertions in `src/steps/`; reuse existing steps.
- Put protocol fixtures and timing controls in `src/mocks/`, not feature steps.
- Keep scenario-owned state in `AgoraxWorld`. Each scenario gets a fresh browser
  context; the browser process is shared across the suite.
- Use fixture IDs and exact message assertions. Do not depend on existing local
  sessions, authenticate against real accounts, or call real models.
- Prefer observable state and controlled promise gates to arbitrary delays.
  For race regressions, prove the intended ordering before releasing a gate.
- Keep an SSE stream open when testing an in-progress turn. A buffered
  `route.fulfill()` response cannot reproduce token-by-token timing.
- For endurance scenarios, loop within one scenario/context and record
  the seed and actions. Recreating the page each round does not test accumulated
  in-page state. Keep endurance runs separate from the default regression suite.
- Report actual browser results separately from dry-run and type-check results.

Mocks prove frontend handling of the supplied protocol and ordering. They do not
prove that a real Hermes gateway or managed runtime emits the same events.
