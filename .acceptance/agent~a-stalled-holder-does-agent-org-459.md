An unclaimed ready row starts a FRESH worker: `wake.ts` `ownRowOnly` refuses an idle `worker-<n>` spare for every row but the one it was named for (`spareLabelForRow`), so `route` falls to the spawn path instead of typing a second row into a standing session (the five wakes of `worker-4466`, 2026-10-09). The refusal names the row the spare is for (`is for #4466 only: one instance, one row (#2407)`) and `splitRefusals` reads it as a capacity wait, not a fault.

Acceptance: `bash -c 'cd /home/agent/repos/wt-agent-org-459 && AGENT_ORG_HOST=/home/agent/repos/a11y-witness/.agent-org/host.json npx rstest run --config scripts/rstest/rstest.config.ts src/ready-row-dispatch.test.ts'`

Mutation: `ownRowOnly` made never to restrict (`if (ref === null || ref !== null) return ineligibleReason`) failed 5 of 10 tests, so the fresh-worker, five-rows, refusal and haiku/Sonnet cases depend on it; the restriction applied to the spare's own row too (`const member = familyMember(label, families)`) failed 3 of 10, so a spare is still typed its own row. Both read by `rstest` on the file, mutated file restored from a `cp` copy and `diff`ed identical.

Measured: `VERDICT pass: 10 tests in 1 file` for the acceptance file; with the wake, `engineer-route`, `org-health`, `spawn-memory-floor`, `triage-route`, `work-gate-offer-hierarchy` and `work-gate-claim-stalled` files (27 files), 2 existing tests failed before `src/wake-released-target.test.ts` was changed and pass after (`VERDICT pass: 9 tests in 1 file`): they typed row 3536 into `worker-2702`, the behaviour this row removes, so they now type each row into the spare named for it. `tsc --noEmit` reports 2 errors and 14 tests in 6 packaging/audit files fail, all identically on an untouched `HEAD` worktree (missing `@a11ign/toolchain/mjs-ratchet`, `gh: 502`).

Refuted, and posted on the row: change 2's premise holds only at a row's own address (#2469; the six journal lines are row #4082, whose address `worker-4082` had been prompted for #4415 at 07:24Z), which change 1 closes. A rule that a stalled holder frees its address for a second process is a policy change to #2469 and #2407 and is not made here; the tests state that the idle/done cases pass before the change too. Change 3's premise (rows dropped) is refuted by the journal: #4442, #4468, #4443 and #4180 were SHELVED by their declared waits and B4, then started on Haiku. Change 4: the refusal names row, reason and holders and now names a spare's row.

Closes a11ign/agent-org#459

platform: none; the change is to `wake.ts` routing and its tests.

🤖 Generated with [Claude Code](https://claude.com/claude-code)
