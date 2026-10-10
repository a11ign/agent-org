The gate raises a hold on a row nobody is working: a pull request held `--until closed #N` whose #N is open, unclaimed and closed by no open pull request, for more than 15 minutes, is an `org-health` order to `ceo` of class `hold-on-idle-row`, and the hold is left standing (agent-org#571, follows a11ign/a11ign#4661).

Acceptance:
```bash
npx rstest run --config scripts/rstest/rstest.config.ts --include src/packaging/idle-hold-detector-in-gate.test.ts
npx rstest run --config scripts/rstest/rstest.config.ts --include src/packaging/pr-hold-idle-target.test.ts
npx rstest run --config scripts/rstest/rstest.config.ts --include src/packaging/gate-lifts-resolved-holds.test.ts
```

The three commands were run exactly as written from this branch's worktree, with `AGENT_ORG_HOST=/home/agent/repos/a11y-witness/.agent-org/host.json` set (the tests import `project-config.ts`, which refuses without a host). Printed:
```
VERDICT pass: 13 tests in 1 file -- full report: A11Y_RSTEST_FULL_REPORT=1
VERDICT pass: 12 tests in 1 file -- full report: A11Y_RSTEST_FULL_REPORT=1
VERDICT pass: 24 tests in 1 file -- full report: A11Y_RSTEST_FULL_REPORT=1
```

The three cases the row names, each with its positive control (all in `src/packaging/idle-hold-detector-in-gate.test.ts`, driven through `orgHealthNow`, the gate's own wait read, so the signal is the tick's):
- 16 minutes, #N open, unclaimed, no closing pull request: one signal. CONTROLS: the same hold at 15 minutes yields none, and with `in-progress` on #N yields none (also a `session:*` label alone, and an open pull request whose body says `Closes #N`; one that closes another row does not clear it).
- The same hold on two consecutive ticks (2 minutes apart): ONE `discriminator` and ONE `causeKey`, the prompt's minutes moving from 16 to 18. CONTROL: a hold re-taken (a new marker date) is a different key.
- A target the tick could not read (not in the open rows, the tick's own read refused): no signal and no throw. CONTROL: in that same tick the target WAS asked for (`calls.length > 0`), so the silence is the refusal and not an absent call. The detector alone is also silent for a null wait read, a null pull request list and a malformed pull request.

No new API call: with the target held in the open rows, the tick's `run` seam (which throws on any call) was called zero times and the signal was still raised (`it costs the tick NO API CALL`). The hold is never lifted: the tick's `release` seam is asserted empty in the positive control.

Mutation:
- Each mutant applied by script, run against `idle-hold-detector-in-gate.test.ts`, restored from a copy with `cmp` identical afterwards; never `git checkout --`). Failures are of 13 tests, as printed by the run:
- The gate call never made (the hook in `orgHealthNow` removed): 7 fail, every test that goes through the tick. The leaf's own tests do not fail, so the hook is the part under test.
- Fires at exactly 15 minutes (`<=` to `<` in `idleHoldIncident`): 1 fails.
- Open pull requests that close the target ignored (`openPullRequests: []`): 1 fails.
- The key carries the minutes (the same hold is a new key every tick): 1 fails.
- Claim labels ignored (`in-progress` and `session:*` no longer end it): 1 fails.
- A target the facts do not hold is read as open and unlabelled: 1 fails.
- A hold with no date is read as long enough: 1 fails.
Three of the mutants (15 minutes, claim labels, undated) edit `src/pr-hold-state.ts`, which is outside this row's Region: they were applied in place for the run and restored from the copy, and the file is not in the diff.

Before the change: the new test file was written after the leaf, so it was never run against a tree without it. The evidence that it fails without the change is the first mutant above (the gate call removed: 7 of 13 fail), and the file imports the leaf, so it cannot load without it.

Suite: `rstest run --changed=origin/main` (the module-graph-affected set, 254 files): `31 of 4760 tests failed in 254 files`. The same 9 failing files were run on a clean detached `origin/main` (`1104a891`) with the same environment: `31 of 334 tests failed in 9 files`, and `comm -13` of the two sorted failing-name lists is empty, so none is new (they are `board-truth-audit`, `failure-ledger`, `auto-arm-token`, `milestone-clock`, `milestone-clock-exact-start`, `row-file`, `row-file-refuses-duplicate-title`, `tick-heartbeat-is-written` and `wake-engineer-brief`; their causes were not investigated, they fail identically without this change). `npm run typecheck`: 2 errors, both in `src/packaging/mjs-ratchet.test.ts` (`@a11ign/toolchain/mjs-ratchet` not resolvable in this worktree's `node_modules`), none in a file this row touches. This repository has no `lint` or `verify` script.

Decisions, because the row did not fix them:
- The class is a PAGE in `ORG_HEALTH_CLASSES`, as `class-repeat` is: one hold is one decision, and its key is stable per hold, so a hold that stands is delivered once per window and not once a tick. A digest class would hide the first one.
- The order is built in the leaf as `staleWaitOrders` and `scopeAddedOrders` are, so `src/org-health.ts`'s `SIGNALS`/`REMEDY` and `src/worker-profile.ts` are untouched and no new `cause:` literal exists (`cause: "org-health"`).
- The closing pull requests are the open ones whose body DECLARES `Closes #N` (`declaredClosedRows`, the claim's own reader), because the take-time read's `closedByPullRequestsReferences` is a call per target. The list is complete to `OPEN_PRS_LIMIT`; past it a closing pull request that is not in the list would make a hold look idle. That is the one place this can be early, and it is named here rather than guarded.
- Silent by design: a target that is itself an open pull request, a hold of more than one `Waiting-for:` (which of them ends it is the declarer's), a condition other than `closed`, and a hold with no marker date.

What this row does NOT do: lift the hold (the row's own rule). `.agent-org/failure-classes.json`'s `hold-on-idle-row` `guardNote` still says the detector is not wired; updating it is the follow-up row in a11ign/a11ign the row names, filed after the merge.
