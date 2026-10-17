Row: a11ign/agent-org#1636 -- cut or cache the work-gate's `repository.issues` GraphQL reads (55% of the scheduler's hourly points, #1620).

Done-when (1), the calls that make `repository.issues`, per gate tick (~28 ticks/hour). MEASURED = counted from a stubbed `gh` that logged each call during one gate run in this worktree, cost taken from the ledger's per-call points; INFERRED = not replayed, cost estimated from the query shape (cost ~ requested nodes / 100).
- Closed `answer:` label read (`readClosedAnswerRows`, `src/work-gate/causes/rows-answers.ts`): one alias per label per kind. 34 labels in the home repository + 9 in agent-org: ~43 of ~70 issue points per tick, ~61%. MEASURED.
- ready / backlog / needs:chairman lists, home and agent-org: 2+2+1 points each. MEASURED.
- in-progress OPEN and CLOSED lists: ~1 each. recently-closed: 1. ci-shared-failure x2: 1 each. MEASURED.
- off-board and fragment reads: ~1-3 each. INFERRED (my log parse broke on their multi-line query args, so they were not replayed).
- ready-with-comments (org-retro untiered sweep): daily, a harness artifact. INFERRED.

The change (two cuts, both in the closed answer read):
1. An ended session's label is not asked for (34 -> 7 and 9 -> 3 labels, MEASURED as the count of non-ended labels in the stubbed run). `goneTest` is passed only by the live gate; a test's `run` never reads herdr or the ledgers.
2. The result is kept 5 minutes while the asked labels are unchanged (`keptClosedAnswers`, `src/work-gate/reads.ts`). Never keeps `null`; no conditional means no keep.

Projected hourly `repository.issues` (INFERRED, not measured on the host): 2,043 - 33 pts x 28 ticks ~= 1,035 after cut 1, ~850 with the 5-minute keep on top. The measured number is Done-when (2), below.

Acceptance: `node --test src/packaging/closed-answer-ended-labels.test.ts`

The file has 6 tests: filtered names asked; the control asks all; all-ended reads nothing and answers `[]` not `null`; a live+ended row still comes back; the keep serves inside the age, re-asks at it and on other labels; a refusal is not kept and no conditional keeps nothing.

Measured: `ℹ tests 6, pass 6, fail 0` for the command above, run in the worktree; `pnpm run typecheck` exits 0. `pnpm test`: 78 of 12154 failed, and the same files fail with the same counts on a `git archive` of `HEAD` (checked per file with `node --test`), except the two mine (fixed) and `queue-stalled` (3 on base, 2 here, flaky).

Mutation: one exact change each, source backed up with `cp` and restored with `cp` and `diff` clean. Keep never served: 1 failing (the keep test). Signature ignored: 1 (keep test). Max age removed: 1 (keep test). Ended-label filter off: 3 (filter, all-ended, keep). Unmutated: 6 pass. Not mutated: saving a `null`, guarded only by the refusal test asking again.

NOT DONE, host-side and after merge (cannot be run from this session): `node src/gh-ledger.ts <gh-calls.tsv of app:scheduler ledger> --account app:scheduler --by-query --since <1 h after the host runs the change>` posted on a11ign/agent-org#1618 and #1620, with `repository.issues` under 1,000 pts.

Closes a11ign/agent-org#1636
