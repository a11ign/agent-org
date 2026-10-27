An approved, armed pull request that GitHub keeps BLOCKED behind a cancelled duplicate run of its required check has that run rerun once, by the board (`watchFeedback`, `src/ticket-mode/pool-cancelled-gate.ts`), with no worker round: the code host reruns the whole cancelled run (`rerunRuns`, `gh run rerun <id>`) and the run's log records a `cancelled-rerun` event, which is also the bound of once for a head (it survives a restart of the board). A pull request that is not approved, not armed, not BLOCKED, or blocked on a red or running required check has nothing rerun. The GitHub plugin reads `blocked` and `cancelledRequired` (every non-green run of a required check on the head is a cancelled one; all runs of a name are read), and the code host contract is 1.28.

Acceptance:
```bash
npx rstest run --config scripts/rstest/rstest.config.ts src/ticket-mode/pool-cancelled-gate.test.ts plugins/github/pull-feedback.test.ts plugins/github/check-runs.test.ts
```

The double `ci` run: announcement-emulator's `ci.yml` listened to `edited` as well as `synchronize`, so a push followed by an edit of the pull request's body started two runs of one head (its own pull request has the same change, with a shape test). The other repositories keep `edited` on purpose (their changeset check reads the body).

Consumer-declaration: none -- no host file, queue file or setting changes meaning. The run log gains a `cancelled-rerun` event (`url`, `head`, `checks`), which the run timeline in the UI words; a plugin of contract 1.27 simply says none of the new fields.
