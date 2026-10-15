An installation refused for a rate limit while its hourly pool still has calls left is a secondary limit in `host/gh` (`rate_limit_kind`, `pool_probe`, `queue_reset_at`) and in `src/gh-ledger.ts` (`refusalKind`), and every real call the wrapper makes is paced per installation role (`pace_slot`, `pace_start`, in-flight and per-minute bounds shared across processes through `A11Y_GH_PACE_DIR`). A read refused for a secondary limit is not asked again in the same tick (`readUnlessRefused`, unchanged; pinned by #1523's test and by this row's test (c)).

Acceptance:
```bash
node --test src/gh-secondary-burst.test.ts
```

Consumer-declaration: host's step -- the wrapper is installed by `host:install`, which host runs; this PR does not run it. Until host does, the installed `gh` reports DIVERGED under `host:check`.
