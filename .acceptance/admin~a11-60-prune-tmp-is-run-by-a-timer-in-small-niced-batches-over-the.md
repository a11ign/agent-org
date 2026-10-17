## What it is

The tmp janitor (`src/prune-tmp.ts`, run every minute by `a11ign-tmp-prune.timer`) classifies only the fixture families in `FIXTURE_PREFIXES`. On 2026-10-17 its daily `tmp-entries:` lines read 2,312, then 4,802, then 6,939, and its dry run said `nothing to remove: 0 classified path(s) found` while `/tmp` held 6,761 entries. The test suites of this host's other repositories write their fixtures to the shared `/tmp`, and none of their prefixes were in the list.

## Change

`FIXTURE_PREFIXES` now carries the prefixes those suites make, grouped by the repository that makes them, each group naming the file that makes it. `outside-nightly-project-` and `outside-nightly-stub-` are agent-org's own (`src/outside-nightly.test.ts`). The removal budget, the pause, the niced unit and the one-hour window are unchanged, and no unit or timer text changes.

Tests in `src/prune-tmp-janitor.test.ts` pin that each leaked prefix classifies as a fixture with a random suffix and that its bare name does not; that a near miss stays unrecognised; that a `/tmp` of 3N leaked-family fixtures needs three runs and a fourth says it found nothing; and that a young or held one is kept with its reason.

Refs A11-60

Flag: none -- the list is data read by the janitor the timer already runs; no behaviour is gated.
Health-signals: none
Revert: revert this PR. The janitor goes back to classifying only agent-org's own fixtures and reports `0 classified path(s)` on this host.

Acceptance: `bash -c 'cd /home/agent/repos/.tickets/A11-60/agent-org && pnpm exec rstest run --config scripts/rstest/rstest.config.ts src/prune-tmp-janitor.test.ts src/no-project-names.test.ts && node src/prune-tmp.ts --fixtures-only | head -3'`
