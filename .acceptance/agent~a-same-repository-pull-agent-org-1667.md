A same-repository pull request with a `session:` label that `reviewTrustOf` classes OUTSIDE is now named, and an OUTSIDE not-convinced verdict whose only finding is "no CI Acceptance run is available" wakes that pull request's reader (`ownerOfPr`). Both are read only while `reviews.outsideSessionPr` is ON (OFF when absent, which is the default, and every order and signal is as it was). The signal is `session-pr-classed-outside`: its detail names the pull request, the author's login, the session and the minutes, and it reaches `ceo` through the digest's reading path. The canary still stores numbers only (`CanaryFacts.sessionPrOutside`), so its samples are unchanged.

Commits: `f9a2aa00` (the wake rule and the detector), `7072c592` (the named reading and its wiring).

Acceptance:
```
cd /home/agent/repos/wt-agent-org-1667 && AGENT_ORG_HOST=/home/agent/repos/role-product-manager/.agent-org/host.json node_modules/.bin/rstest run --config scripts/rstest/rstest.config.ts src/packaging/outside-session-pr.test.ts
```

`AGENT_ORG_HOST` is needed: `src/project-vocabulary.ts` reads the project declaration (`RESOURCES`) at import, and the file is unchanged from `origin/main`.

Mutation: the named reading's flag check made to read `if (false) return [];` (`src/org-health.ts`, `sessionPrOutsideReadings`) failed 1 of 14; the wake rule made to keep any not-convinced verdict (the `onlyNoAcceptanceRun` phrase test removed) failed 2 of 14; the detector made to drop the `sessionOf(pr) !== null` requirement failed 2 of 14. Each restored file gave `VERDICT pass: 14 tests in 1 file`.

Measured: `VERDICT pass: 14 tests in 1 file` (acceptance file); `tsc --noEmit -p tsconfig.json` exits 0. The affected-file run (124 files, `AGENT_ORG_HOST` set) reports 30 failures, all in six files (`live-tree-independence`, `org-health`, `work-gate-a11ign-readers`, `tmp-fixtures-are-removed`, `work-gate-github-incident`, `work-gate-runner-start-red`). The same six files fail the same 30 tests at `origin/main` (`Cannot find module 'tsx/package.json'` for two of them; the rest are hold, runner-start and red-check assertions), so none is caused by this change. The baseline of 30 of 2433 is accepted by product-manager (row comment 2026-10-17T07:14:21Z).

Outside-Region: the wiring of the wake rule and the canary sits in files the row's Region does not list, and each is named here with its reason.

Outside-Region: src/flag-switch-ledger.ts — `FLAGS_WITH_ANOTHER_HOME` names `reviews.outsideSessionPr` as switched by `machinery:flag`, so the ledger's registry pin passes for a flag that has no declaration file.
Outside-Region: src/packaging/machinery-flag-switch.test.ts — the registry pins read the new flag in their loop and deep-equal.
Outside-Region: src/work-gate.ts — reads the flag once per tick with the canary's state and hands the named reading and the canary's numbers to their readers.
Outside-Region: src/work-gate/causes/org-health-github-incident.ts — `machineryCanaryNow` takes the classed-OUTSIDE numbers (`sessionPrOutside`) and counts them under the memo clock.
Outside-Region: src/work-gate/org-health.ts — `orgHealthNow`'s io gives the named reading its fact (`readSessionPrOutside`); OMITTED is "does not ask".
Outside-Region: src/work-gate/tick.ts — the wake set is computed only with the flag ON and passed to `withholdOutsideFollowUps`.

Outside-Region: src/work-gate/org-health-suppression.ts — `ORG_HEALTH_CLASSES` declares `session-pr-classed-outside` as PAGE, so the class is named in the table and not left to the PAGE default (product-manager's ruling on the row, 2026-10-17T07:14:21Z).

The diff adds `session-pr-classed-outside` to `STANDARD_MACHINERY_SIGNALS` (it is the new entry in `MACHINERY_SIGNALS`, `src/org-health.ts`). The installed tool does not record it until a release carries this change, so `Health-signals` names the installed tool's own signals: `wakes-held` (the wake rule changes which orders ride) and `blind-ticks` (the named reading is read in the tick). The canary watches the new signal once it is released. This PR switches nothing on: the flag is OFF by default, and the switch row a11ign#5676 waits on #1684 and on this row.

Switch row: `reviews.outsideSessionPr` is a11ign#5676, which already exists (a11ign#5675 is `gh.refuseFallbackAuthor`, not it).

Done-when 1, as the row now states it: #1615's verdict is named from its gate record on GitHub, and #1663 has no GitHub record and the gate's snapshot is not on this host, which the row's amended Done-when accepts as a complete answer.

Flag: reviews.outsideSessionPr
Health-signals: wakes-held, blind-ticks
Revert: turn `reviews.outsideSessionPr` off (it is OFF by default), or revert this PR.

Closes a11ign/agent-org#1667

Draft-because: a product change, opened as a draft for the reviewer, per product-manager's ruling on the row (2026-10-17T07:14:21Z).

🤖 Generated with [Claude Code](https://claude.com/claude-code)
