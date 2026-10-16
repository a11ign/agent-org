The work-gate's per-tick cap is decided from the per-read table on a11ign/agent-org#1618: `TICK_POINTS_CAP` stays 60 and the comment beside it records why. The change the table names (`repository.issues`, 55% of the scheduler's hourly points) is agent-org#1636.

Acceptance:
```bash
git grep -n "TICK_POINTS_CAP = " -- src/gh-conditional.ts
```

Consumer-declaration: none -- a comment on a constant; no behaviour changes.
