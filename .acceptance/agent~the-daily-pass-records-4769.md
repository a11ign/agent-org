The daily pass records an open row (claimed or not) whose deliverable pull request merged more than 30 minutes ago as a `row-not-finishable` ledger incident (chairman, a11ign/a11ign#4437). This is the whole of a11ign/a11ign#4769.

Closes a11ign/a11ign#4769

## What changes, and why

- **The detector** (`src/merged-row-open-incident.ts`, new, pure): `mergedRowOpenIncidents({ rows, mergedPrs, openPrs, now })` returns one incident per open row that a pull request names as its deliverable, when the newest such merge is more than `MERGED_ROW_OPEN_MINUTES = 30` old. "Names" is `extractClosesDeclaration`'s reading (the parser CI and `pr:open` use): a `Closes` list, a `Closes: none` line whose reason names the row, or the branch the row's claim record names. `Refs`/`Part of`/prose name nothing. Not incidents: an epic, a row a still-open pull request also names, a merge at exactly 30 minutes or inside it, a merge time that is absent or does not parse.
- **The ref names the episode**: `<tracker>#<row>@<repo>#<pr>`, repository-qualified because `#7` exists in both trackers and a bare `#7` in a pull request is its own repository's row. `recordFailures` skips a (key, ref) already logged, so a merge seen on every daily pass is one line and a later merge on the same row is a second.
- **The daily pass** (`src/org-retro.ts`): `readMergedRowOpen` lists every declared tracker's open rows (and the claim record's branch, from the `in-progress` rows' comments) and every declared code repository's merged and open pull requests; the report prints `Rows still open more than 30 minutes after their deliverable merged: N; first: ...`; `retrospectiveTick` records the events beside the idle-claim ones.
- **`null` is unknown, never 0**: ANY refused list, or one at its 1000 ceiling, makes the whole read `null` and the report says `unknown`. A repository that could not be listed is a deliverable nobody could see.
- **The merged read looks back 7 days, not the report's 24 hours**: the first pass that sees a merge may run before it is 30 minutes old, and the next one is a day later, so a 24-hour read would let a merge age out unseen.

## Not in this row

- **No call from `src/work-gate.ts` or `src/wake.ts`** (both hot, outside the Region): the daily pass is the only caller. A tick-time reader is a follow-up if one is wanted.
- **The class's `guard` in `.agent-org/failure-classes.json`** is a later edit in a11ign (the row's item 4).
- **A row reopened after its deliverable merged reads as an incident**: an issue listing carries no "reopened at", so this cannot tell it from one that was never closed.

## Platform first, deleting first

platform: nothing in GitHub reports "an open row whose closing pull request merged" (a `Closes` is closed by the merge itself; what is left open is left open by a `Closes: none` or a bot merge). Nothing was deleted: `extractClosesDeclaration`, `ROW_NOT_FINISHABLE` and `recordFailures` are reused, so the new code is the decision and the read only.

## How you verified it

The tests need `AGENT_ORG_HOST` (this worktree holds no `.agent-org/project.json`); run with it set to `/home/agent/repos/wt-4769/.agent-org/host.json`. Measured on this host, at this head:

- The Acceptance: `VERDICT pass: 24 tests in 1 file`. Every "no incident" case has a twin, the same fixture with one thing changed that does produce one.
- The full `rstest` suite: 34 failing, and the same 34 (28 distinct test names, all under `src/packaging/`, `board-truth-audit` and `failure-ledger`) fail on a clean `origin/main`. The suite's TOTAL varies between runs on one commit (8161 and 8187 on `origin/main`), so no total is quoted as a comparison.
- `tsc --noEmit`: only the two `src/packaging/mjs-ratchet.test.ts` missing-module errors, which `origin/main` has too.

Acceptance: `npx rstest run --config scripts/rstest/rstest.config.* src/merged-row-open-incident.test.ts`

Mutation: 19 mutants, each applied alone to a copy and restored with `cp` (byte-identical, `diff`ed), each killed by the test that names its guard and by no unrelated one. Never fires (threshold always true) -> 20 red; always fires (no threshold) -> 2 red (the boundary, the newest-merge-decides control); `<` for `<=` -> 1 (the boundary); epic exclusion removed -> 1; open-PR exclusion removed -> 3; claimed branch ignored -> 5; `Closes: none` reason ignored -> 1; any `#n` in the body counts -> 1 (the reference-only case); bare number resolved against the tracker -> 1; oldest merge decides -> 2; unparseable `mergedAt` read as long ago -> 1; ref drops the merge -> 7; a refused list read as empty -> 2; list ceiling ignored -> 1; look-back 24 hours -> 1; claim comment's branch never read -> 3; the tick records nothing -> 1; the report line missing -> 1; a `null` summary printed as 0 -> 1.
