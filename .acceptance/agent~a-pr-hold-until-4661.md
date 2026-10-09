`pr:hold --until="closed #N"` is refused while #N is open, carries neither `in-progress` nor a `session:` label and has no open pull request closing it, before any label is written; and `idleHoldIncident` reads a hold already in force on such a target as an incident after more than 15 minutes (a11ign/a11ign#4661, class `hold-on-idle-row`).

Acceptance:
```bash
npx rstest run --config scripts/rstest/rstest.config.* src/packaging/pr-hold-idle-target.test.ts
```

The row's command is `cd ~/repos/agent-org && npx rstest run --config scripts/rstest/rstest.config.* src/packaging/pr-hold-idle-target.test.ts`; the primary checkout carries the new test only after the merge, so the command above is the same one run in the PR's own tree. `AGENT_ORG_HOST` is set to a11y-witness's `.agent-org/host.json`, which the run needs. Printed:
```
VERDICT pass: 12 tests in 1 file -- full report: A11Y_RSTEST_FULL_REPORT=1
```

Mutation (each applied to `src/pr-hold-state.ts`, run against the acceptance file, restored byte-identical with `diff` against a copy):
- `holdTargetIdleReason` never fires (`if (wait) return null`): 6 of 12 fail: the #4524 positive control, the refusal, the bare-`#n` test, and the three `idleHoldIncident` tests that need a reason.
- always fires (claim and pull-request checks removed): 3 of 12 fail: the claim/PR-is-not-idle test, the not-an-incident test and the take-is-allowed control. The refusal tests and the `manual`/`merged` controls still pass, so the two directions break different tests.
- boundary `<=` made `<`: 1 of 12 fails, the 15-minutes-null / 16-incident test.
- the incident key includes the minutes: 1 of 12 fails, the once-per-hold test.

Existing tests: `pr-hold.test.ts`, `pr-hold-any-declared-repository.test.ts`, `a-hold-means-cannot-merge.test.ts` and `wait-condition.test.ts` pass with this change (106 tests with the acceptance file). One pinned call list in `pr-hold-any-declared-repository.test.ts` ("(2) THE FIRST REPOSITORY IS UNCHANGED") gained the one new read, `issue view 148 ...`, declared as `Outside-Region` in the body: a `closed #N` take now reads the target before it writes anything, and a test that pins every `gh` call of such a take cannot stay unchanged.

Done-when 2, the refusal printed for the #4524 fixture (open, `ready`, `lane:any`, no closing pull request), `pr-hold.ts 550 --repo-key=agent-org --session=ceo --until="closed a11ign/a11ign#4524"` against a fake `gh`, exit 1, no write reached:
```
REFUSING --until="closed a11ign/a11ign#4524": a11ign/a11ign#4524 is OPEN, nobody holds it (no `in-progress` and no `session:*` label) and no open pull request closes it, so the condition cannot come true while it stays so: the held pull request would sit green until somebody happens to claim the row. Nothing was written. Merge agent-org#550 and let the row rebase when it lands (a row that lands after you has nothing to wait for), or take the hold with `--until=manual`, which is counted and expires after 4 hours.
```

Suite: the whole `agent-org` suite on this branch rebased on `origin/main` `a2163e1`, with `AGENT_ORG_HOST` set as above: `33 of 7871 tests failed in 429 files`. None is in a `pr-hold*` or `wait-condition` file; they are `milestone-clock*`, `mjs-ratchet`, `public-claim`, `pr-template-acceptance`, `auto-arm-token`, `board-truth-audit` and `row-file-refuses-duplicate-title`. Not re-measured on a bare `origin/main`: sibling pull requests (#558, the 4582 branch) report the same count of 33 on theirs.
