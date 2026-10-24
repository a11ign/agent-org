## What it is

`agent-org start herdr` (with or without `--move`) no longer ends in Node's "Detected unsettled top-level await" with exit 13 and nothing else (A11-225).

- **The pending await.** `service.ts` was the entry module of `start`, `stop` and `status` and ended with `process.exitCode = await main(...)`. `main` does `await import("./herdr-move.ts")`, and `herdr-move.ts` imports `service.ts`, which was still evaluating, so the import waited on `main`, which waited on the import. It is platform-neutral and happens before any herdr or launchctl call. The entry is now `src/install/service-cli.ts`, which nothing imports; `service.ts` is a library and `main` stays exported from it.
- **Every wait is bounded.** Each `launchctl`, `systemctl` and `herdr` call has a 120 s limit and fails with `` `<command>` did not finish within 120s ``. The move awaits the unit start and the guard retirement through `withinTime` (60 s each, a message naming the step). The polls for the old server to go and for the new one to answer are 20 x 500 ms.
- **The move reports each step** as it finishes: `step 1 of 4` registered the unit, `step 2 of 4` stopped the server that ran outside (or none did), `step 3 of 4` started the unit, `step 4 of 4` the server answers in the unit; then the guard retirement's lines and `moved herdr into its service: ...`. A failing step is refused as `step <n> of 4 (<what>) failed: <why>. <fix>`. Plain `start herdr` prints its one line as before.
- **`runCommand` wraps every service command's `main`** (`start`, `stop`, `status` through `service-cli.ts`, and `update`): a process that exits before its body settled gets `agent-org <command>: ended before it finished ...` on stderr, and keeps Node's exit code 13.

## Acceptance

Acceptance:
```bash
bash -c 'set -euo pipefail
npx rstest run --config scripts/rstest/rstest.config.ts src/install/herdr-move.test.ts src/install/time-limit.test.ts src/install/command-exit.test.ts src/install/service-cli.test.ts src/install/herdr-service.test.ts src/install/service.test.ts src/install/service-launchd.test.ts src/packaging/bin-commands.test.ts
npm run typecheck
npx eslint src/install --quiet'
```

Proof of each line of the ticket:

- Find the pending await, and bound the waits: `src/install/service-cli.test.ts` runs the real `bin.ts start herdr` and `start herdr --move` and requires exit 2 and the host-file refusal, never "unsettled" (on the base commit both fail with the ticket's exact warning); `src/install/time-limit.test.ts` "a wait that never settles times out with a message that names it" and "a command that does not finish is killed and answers a failed result that says so"; `src/install/herdr-move.test.ts` "guards whose retirement never settles time out with a message instead of ending the process".
- The move reports each step: `src/install/herdr-move.test.ts` "the macOS move, with launchctl and herdr stubbed, completes and reports each step in order, then a result line"; the failure cases "a server that never comes up in the unit refuses at step 4 ...", "a launchctl that refuses the unit fails step 3 ... a herdr that will not stop fails step 2 ...", "a unit that cannot be written fails step 1 ...".
- The wrapper: `src/install/command-exit.test.ts` "a process that exits before the body settles gets one line that names the command", "a real process whose body never settles exits 13, ... and names the command on stderr", and the cases for a body that settles or throws.
- A wait that never settles times out with a message: the `time-limit.test.ts` case above.

The After-merge line of the ticket runs on the laptop: `agent-org start herdr --move` prints `step 1 of 4` to `step 4 of 4` and `moved herdr into its service: ...`, and exits 0.

Consumer-declaration: none -- no option is added to a project declaration. `MoveDeps` gains an optional `limitMs`, which every existing caller leaves unset.
