The failure ledger records an UNANSWERED claimed-worker nudge, not every nudge: `stalledNudgeEvents` writes the `claimed-worker-stalled` line from a `release` reading with `why: "stalled"` and a `nudgedAt` (the second reading found the claim still stopped after the nudge), no longer from a fresh nudge, so four answered nudges leave no `class-repeat` and two unanswered ones do (a11ign/a11ign#4826)

Acceptance:
```bash
bash -c 'cd /home/agent/repos/agent-org-wt-4826 && AGENT_ORG_HOST=/home/agent/repos/a11y-witness/.agent-org/host.json npx rstest run --config scripts/rstest/rstest.config.ts src/claimed-worker-stalled-ledger.test.ts'
```

Printed `VERDICT pass: 3 tests in 1 file` (`node --import tsx --test` on the same file, the row's own spelling: `ℹ pass 3`, `ℹ fail 0`; the body parser refuses that spelling's `&&`). The cases run the REAL writer (`claimStallTick` with its own `recordStalledNudges`, over a temporary state directory) and read the file back through `parseFailureLedger` and `repeatsIn`, the pair `class-repeat` reads: four nudges on four rows (4799, 4808, 4787, 4804), each answered by a row comment two minutes later, leave NO line and NO repeat, and the test first asserts all four WERE nudged, each under the wake ledger's `nudgeKey`; its positive control, two rows nudged and never answered, are released and leave two lines and ONE repeat; and one unanswered nudge beside four answered ones is one ref and not a repeat, while a second unanswered nudge on the same row is a second ref and is. The Acceptance command as the row wrote it (`cd /home/agent/repos/agent-org`) names the primary checkout, which holds this file only after the merge.

Mutation:
(both directions, restored from a `cp` and `diff` showed it byte-identical each time; run over `claimed-worker-stalled-ledger.test.ts` and `idle-claimant-stopped.test.ts`, 20 tests)
- The writer fires on a FRESH nudge, as before this change (`reading.kind === "nudge"`, ref on `now`): 6 of 20 red, the answered-nudges case and the mixed case among them.
- The writer never fires (`false`): 7 of 20 red, the positive control, the `repeatsIn` twin and the refused-append case among them.
- The ref carries the tick's `now` and not the nudge's `nudgedAt`: 7 of 20 red.

Judgement calls:
- **The observable is (a), the release with `why: "stalled"`, not (b) a second nudge on the same row.** A second nudge only follows a MOVE (the clock restarts at `lastMoveAt`), so it is "answered once, stopped again" and not "unanswered". (a) is the second reading's own verdict and needs no new state.
- **The ref names `nudgedAt`.** The release is read `STALL_INTERVAL_MS` or `STALL_UNTOLD_RELEASE_MS` after the nudge; a ref on `now` would read the same episode as a different line on every tick that offers it, and a line in the ledger would no longer find its key in the wake ledger.
- **An undelivered nudge that releases after 2N is recorded too.** The claim was released with the work kept, and the holder had not moved: the guard failed to bring it back, whoever's fault the delivery was.
- **NOT RECORDED, by design of the existing rulings:** a `Claimed-nothing:` claim (#3407) and a holder with an open pull request of its own (#2999) are never released and read `nudged` for good, so an unanswered nudge to one is in the wake ledger only. `idle-claimant-stopped.test.ts` pins the open-pull-request case with its control (the nudge IS sent).

Neighbours: `claim-stall-restart-notice.test.ts`, `work-gate-claim-stalled.test.ts`, `failure-ledger.test.ts` and `class-repeat.test.ts`: 192 tests with 1 failing, `failure-ledger.test.ts :: owner-unresolved: a name, guard null and a guardNote`, which also fails on the unmodified primary checkout (it reads the host project's `.agent-org/failure-classes.json`). `tsc --noEmit` reports only the `@a11ign/toolchain/mjs-ratchet` import in `src/packaging/mjs-ratchet.test.ts`, which this tree lacks and this change does not touch.

Open after the merge, not this pull request's: Done-when 2 (the four existing lines in `~/.cache/a11ign/failure-ledger` stop counting) is a write to the host's file and is `orchestrator`'s; Done-when 3 (the class's `guardNote`) is a pull request in `a11ign/a11ign` and is filed as its own row.

Closes a11ign/a11ign#4826
