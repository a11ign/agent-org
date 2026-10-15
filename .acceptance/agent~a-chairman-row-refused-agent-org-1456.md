A refused `priority:chairman` row is told to `ceo` once per reason, and a `ceo` answer on the row silences it until the reason changes or its named blocker closes. `hierarchyOrders` (`src/work-gate/causes/rows-offer.ts`) keeps a first-telling ledger in `chairman-refusals.json` under the state directory, keyed by the row's repository and number (`subjectRef`), and the answer is read lazily by `chairmanRowAnsweredByCeo` (the newest comment whose `decided-by:` marker names `ceo`, read only for a row the gate refuses). A refusal is silenced only when that answer is newer than the first telling for the same digest and the blocker its reason names is still open. The cause key now carries the repository (`ceo/chairman-row-refused/row-agent-org#1456/<digest>`), so the stuck path reads it through `stuckSubjectOf`, which is what the `STUCK ... names no row of a repository this project declares` line was missing.

Acceptance: `cd /home/agent/repos/wt-agent-org-1456 && node --test src/work-gate-offer-hierarchy.test.ts`

Mutation: the silencing made never to apply (`const silenced = false && answered`) fails 1 test (the new one, at the answered-then-silenced step); the silencing made to apply whatever the blocker (`const silenced = answered`) also fails that test, at the closed-blocker step. `rows-offer.ts` restored byte-identical each time (`cmp` against a saved copy).

Measured: `ℹ tests 10 / ℹ pass 10 / ℹ fail 0` for the acceptance file. `tsc --noEmit` exits 0. Across 14 related test files (`closed-pr-answer-owed`, `stuck-escalation-*`, `wake-escalation-answered`, `work-gate-emergency-priority`, `packaging/work-gate`, `stuck-row-*`, `work-gate-chairman-*`, `work-gate-red-pr-waiting`, `work-gate-stuck-escalation-keyed`), the same 37 tests fail with and without this change (compared by name); the base run excludes `work-gate-offer-hierarchy` so its 10 tests account for the difference in totals.

Not here, and named: `pnpm run lint` is not a script in this repository. The `decided-by: ceo` marker on a `ceo` answer is read as written by `src/decided-by.ts`; that every `ceo` answer on a chairman row carries it is not verified here. The primary's existing `ceo/chairman-row-refused/<n>-<digest>` keys become `row-<n>/<digest>`, so each currently refused chairman row is told once more after this lands.

Closes a11ign/agent-org#1456

platform: the ledger is a JSON object written by `writeJsonObject` (write to `.tmp`, rename), and an unwritable ledger is said and re-tells on the next tick, which is the old behaviour.

🤖 Generated with [Claude Code](https://claude.com/claude-code)
