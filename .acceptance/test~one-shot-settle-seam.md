`ceo-one-shot.test.ts` and `orchestrator-one-shot.test.ts` hand `deliver` a no-op `sleep`, the seam `wake.ts` keeps for exactly this, so no case waits the real five-second `CLEAR_SETTLE_MS`.

Acceptance:
```bash
npx rstest run --config scripts/rstest/rstest.config.ts src/ceo-one-shot.test.ts src/orchestrator-one-shot.test.ts
```

Consumer-declaration: none -- two test files; no non-test file under `src/` changes.
