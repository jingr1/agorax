# Autoresearch demo — orchestrator dispatch

## Quick start (one command)

```bash
cd /home/ramon.jing/hermes-workspace
orchestrator:autoresearch chat -q "/autoresearch autoresearch-demo/contract.yaml"
```

## Explicit two-step flow

1. **Orchestrator** validates contract and greenlight:
   ```bash
   cd /home/ramon.jing/hermes-workspace
   orchestrator:autoresearch-dispatch chat -q "Validate autoresearch-demo/contract.yaml and output DISPATCH checkpoint"
   ```
2. **Orchestrator** dispatches executor per `executor:` field:
   ```bash
   architect:autoresearch chat -q "Execute autoresearch per autoresearch-demo/contract.yaml"
   ```
   For code targets use `developer:autoresearch` instead.

## One-shot pilot (executor only, contract pre-approved)

```bash
cd /home/ramon.jing/hermes-workspace
architect:autoresearch chat -q "Run autoresearch per autoresearch-demo/contract.yaml. Log to autoresearch-results/demo-pilot.tsv."
```

## Notes

- Contract paths are **relative to workspace root** (`autoresearch-demo/...`), not `hermes-workspace/...` prefix.
- Wrappers preload only `autoresearch-*` skills via `-s`; profile core skills load from profile config.

- Baseline metric from `eval.sh`, then up to 2 iterations on `routing_hint.md`
- TSV rows in `autoresearch-results/demo-pilot.tsv`
