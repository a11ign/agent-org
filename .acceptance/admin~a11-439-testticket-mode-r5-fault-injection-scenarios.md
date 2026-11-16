## What it is

A fault-injection command that rehearses the board's known failure modes on a fixture instance (A11-439): `node scripts/fault-injection.ts [--scenario <name>]...`. Step 2 of 2 adds the last three scenarios and completes the stuck-run report.

The fixture instance starts from ticket:capture's throwaway host file and runs the board's own pool over in-memory fakes. Each scenario queues two runs, injects its fault on a schedule, lets scripted workers finish, and reads every run as its card shows it. The report lists each run's status and reason, and the run log and journal lines of every run left stuck with no reason shown. It exits 0 when none is stuck, 1 when one is, and 2 for an unknown scenario. The five scenarios:

- `linear-5xx` and `herdr-killed` (step 1).
- `check-cancelled`: each run's approved, armed pull request is held BLOCKED by a cancelled run of its required check. FIX-1's rerun goes green and the pull request merges. Every run of FIX-2's is cancelled, and its card says the board stopped rerunning.
- `merge-queue-ejection`: FIX-1 is removed for a registry error in the `merge_group` install. The board re-arms it with no round, and it merges. FIX-2 is removed by a person, and the card says a person decides.
- `update-during-run`: an update restarts the instance while it opens FIX-2's workspace. The old instance's writes are lost and its herdr calls fail. The new version's instance reconciles, re-adopts FIX-1, and queues FIX-2 again for the restart (A11-294).

Pull requests are the code host contract's in-memory fake, unwrapped, seeded through the contract's own fields. The tracker links each one open and then merged, as Linear's GitHub integration does. Between passes GitHub answers only what the board asked for (`fault-pulls.ts`). The fixture runs the server's sweeps on their own cadence: `refreshTracker` every `TRACKER_MS` (now exported from `server.ts`) and `watchFeedback` every `FEEDBACK_MS`.

The stuck rule is stricter: "Awaiting review" no longer explains a run whose open pull requests are all approved at their heads (the A11-342 shape).

## Acceptance

`scenarios.test.ts` runs every scenario through the command. It reports no stuck runs, exits 0 and makes no network call. Each new scenario's test checks the board's own action: the `cancelled-rerun` in the run log, the person's removal named in the journal with no round started, and `requeued` for `restart` with FIX-1 started once. A code host that cannot rerun leaves both check-cancelled runs listed stuck, and the command exits 1. `fault-pulls.test.ts` runs the code host conformance suite on a fake seeded with both faults and checks how GitHub moves the pull requests. `stuck-runs.test.ts` checks the approved-at-head rule.

Acceptance:
```bash
bash -c 'set -euo pipefail
npm run typecheck
npx eslint src/ticket-mode/fault-injection scripts/fault-injection.ts src/ticket-mode/server.ts --quiet
npx rstest run --config scripts/rstest/rstest.config.ts src/ticket-mode/fault-injection/ src/ticket-mode/pool-readopt.test.ts src/ticket-mode/pool-cancelled-gate.test.ts src/ticket-mode/pool-merge-queue.test.ts
node scripts/fault-injection.ts'
```

Mutations, each run on this branch and each failing the named test:

- `pool-readopt.ts` `requeueOrLose` always loses the run (A11-294 reverted): the update-during-run test fails, because the log says `retry`, not `restart`.
- `pool-merge-queue.ts` `canAskArmBot` returns false: the merge-queue-ejection test fails.
- `stuck-runs.ts` `explainsItself` ignores approvals: the no-rerun test and the stuck-runs approval test fail.

Consumer-declaration: none. The command is a development script under `scripts/`, which the package does not ship. Nothing an installed agent-org runs imports `src/ticket-mode/fault-injection/`. `server.ts` only gains an `export` on `TRACKER_MS`.
