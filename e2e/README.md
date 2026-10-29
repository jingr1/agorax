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
| `@CHAT-RECOVERY-001`  | Completed history renders once in an idle state                      |
| `@CHAT-RECOVERY-002`  | Reload removes stale waiting state for a completed session           |
| `@GROUP-SEND-001`     | SSE refresh before POST completion does not duplicate a room message |
| `@CHAT-LIFECYCLE-001` | Completed streaming reply survives reload without duplication        |
| `@CHAT-LIFECYCLE-002` | A failed send displays an error and permits a successful new send    |
| `@CHAT-LIFECYCLE-003` | Switching sessions mid-stream does not mix transcripts               |
| `@CHAT-LIFECYCLE-004` | Stopping generation permits another successful turn                  |
| `@CHAT-SOAK-001`      | Seeded same-page multi-turn chat preserves messages and drafts       |

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
the unchanged document identity. It does not reload the page between rounds.
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
