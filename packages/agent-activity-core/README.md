# Agorax Agent Activity Core

Framework-neutral canonical state engine for agent sessions, turns,
interactions, queues, reconciliation, and activity snapshots.

The package owns client-side lifecycle projection only. Runtime transport,
provider adapters, Hermes profile handling, and React presentation remain in
their respective Agorax modules. Consumers must address activity with exact
workspace, agent-session, turn, request, and target identities.

Run its focused suite with:

```bash
node --test --experimental-strip-types './src/**/*.test.ts'
```