A written reviewer verdict that never reaches its pull request, and a conflicting pull request whose worker is idle, are health signals within 15 minutes (`verdict-written-undelivered` and `conflicting-pr-worker-idle`). The drop: Codex puts a `• ` bullet in front of the first line of a final message, so an outside reviewer's `• BEGIN REVIEW VERDICT #1615 at ...` was rejected by the strict reader `outsideVerdictBlock` (`src/review-trust.ts`). The door was never called, and a11ign/agent-org#1615 has no review (`gh pr view 1615 --repo a11ign/agent-org --json reviews` reports zero). `reviews.verdictDelivery` (OFF by default) reads the bulleted block and posts it through the door.

**What changes.**
- *The drop, named.* `outsideVerdictBlock(paneText, pr, { bulleted })` strips the bullet from the BEGIN and END lines only, and only when `bulleted` is set. The body keeps its own bullets. `postOutsideVerdicts` takes `delivery`, which the wake passes from the flag; OFF keeps the strict reader.
- *The record.* `src/verdict-delivery.ts` writes `verdict-written.json` in the state directory: each bulleted verdict the outside panes show, keyed `<session>@<head>`, with the time it was first seen. The gate reconciles it against GitHub each tick: a verdict of the same word at the written head is delivered; a pull request that is no longer open, or whose head has moved on, leaves the record. An unparseable record throws, and the gate reads it as unread.
- *Signal `verdict-written-undelivered`.* The canary reads the undelivered count, and a verdict trips at 15 minutes from the time it was first seen (`VERDICT_UNDELIVERED_MINUTES`).
- *Signal `conflicting-pr-worker-idle`.* An open pull request whose `conflictStateOf` is CONFLICTING and whose owner's pane is in `IDLE_STATUSES` is counted; the canary's memo starts its clock, and it trips at 15 minutes (`CONFLICT_IDLE_MINUTES`).
- *The flag gate.* With `reviews.verdictDelivery` OFF, `verdictUndeliveredNow` and `conflictingIdleNow` return `null` (unread) without reading the record or GitHub, and the wake neither records nor reads the bulleted blocks. The canary runs no clock for either signal.
- `VERDICT_DELIVERY_FLAG` is registered in `FLAG_REGISTRY` and `FLAGS_WITH_ANOTHER_HOME` (switched by `machinery:flag`).

**Not changed, a separate finding.** `WORDS` in `src/review-verdict.ts` (line 38) does not match the hyphenated `not-convinced`, so the approval parser reads `not-convinced` as `convinced`. It is shared gate code, and fixing it changes gate behaviour, so this row does not touch it. The test fixtures write `not convinced`.

**Assumptions (routine calls, noted for the task log).**
- Outside reviewers cannot post; the gate posts their verdict with the reviewer's identity (`reviewerEnvironment`), as before.
- The inside reviewer posts through the door itself; the record covers the outside reviewers only.
- A verdict's clock starts when the wake first sees the block, not when the reviewer wrote it.

**Measured.**
- `src/packaging/verdict-delivery.test.ts`: 10 of 10 pass. Tests (1)–(8) cover the drop, the flag, the record, the conflict, the signals, the wake side, the flag gate, and the fourteen/fifteen-minute edge.
- `pnpm run typecheck`: exit 0.
- Affected set, after the rebase onto `origin/main` (48ac9b46): the 372 test files that name the changed modules, 73 of 6102 tests fail. The same 73 tests fail on a detached `origin/main` worktree (73 of 6092). No new failure. The first run after the rebase had one more, `work-gate-size` "no cause module imports another cause module": the incident module imported `readReenqueueState` from `pr-ejected.ts`; the flag is now read at the gate and passed in, and the rule passes.

**Mutation:** eight, each red in the test named, each restore byte-identical (the file is copied to the scratchpad before the sed and `cmp`'d after the restore). A to G ran against the nine-test file; H against the ten-test file:

| Mutation | Red test |
|---|---|
| A: the bullet is not stripped (`bulleted` ignored) | (1), (2), (6): 3 of 9 |
| B: the delivered check removed, a delivered verdict stays undelivered | (3): 1 of 9 |
| C: the idle rule inverted (`status !== null \|\| status === null`) | (4): 1 of 9 |
| D: the wake records nothing | (6): 1 of 9 |
| E: the undelivered gate removed (the record is read with the flag OFF) | (7): 1 of 9 |
| F: the idle gate removed (the pull requests are counted with the flag OFF) | (7): 1 of 9 |
| G: the wake's flag gate removed (the bulleted blocks are read and posted with the flag OFF) | (6): 1 of 9 |
| H: the threshold made strict (`>` for `>=`, both signals) | (8): 1 of 10 |

**Not run here.** The row's rehearsal on the agents host (the switch row for `reviews.verdictDelivery`, run through `machinery:flag` and quoted on the row) cannot be run from this session: the agents host is unavailable.

Acceptance: `node_modules/.bin/rstest run --config scripts/rstest/rstest.config.ts src/packaging/verdict-delivery.test.ts`

Closes: a11ign/agent-org#1649

platform: n/a (no GitHub, pnpm, systemd or git feature does this; the reads are the existing `gh pr view --json state,headRefOid,comments,reviews` and the herdr pane read)

🤖 Generated with [Claude Code](https://claude.com/claude-code)
