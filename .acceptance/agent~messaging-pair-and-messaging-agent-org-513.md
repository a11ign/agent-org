`messaging:pair --help` and `messaging:listen --help` print the usage and exit before anything is read or asked (a11ign/agent-org#513). Both entry points ignored the flags they did not read, so `--help` started a Telegram long-poll, which Telegram answered with a 409 to the chairman's running listener; the listener exited 2 and the chairman's messages sat unread for about three minutes.

Closes a11ign/agent-org#513

## What changes, and why

- **`pair.ts`.** `main` parses `argv` with `parseArgs` (strict) first: `--root=<dir>` and `-h`/`--help`. `--help` prints `USAGE` and returns 0; an unknown flag or a positional prints the parser's message (which names it) and `USAGE` to stderr and returns 2 (`EXIT.refused`, new: the file had only "0 paired, 1 not"). `main` takes an optional second argument (`fetch`, `home`, `out`, `err`) so a test can drive it end to end; nothing changes for the entry point, which passes none.
- **`listen.ts`.** `main` takes `argv` in its deps (default none) and parses it first, with the same rules and `EXIT.refused`; the entry point passes `process.argv.slice(2)`.
- **The population.** `git grep -l getUpdates src` lists `poll.ts` (a library), `inbound.ts` and `selftest.ts` (synthetic updates) beside these two, so they are the whole set of entry points that poll. The row's `.mjs` paths are `.ts` on `main`.

## How you verified it

This worktree has no `node_modules`, so `rstest` could not be run from it; the two files are plain `node:test` and were run with `AGENT_ORG_HOST=$HOME/repos/a11y-witness/.agent-org/host.json node --test <file>`. The row's two `rstest` commands were NOT run.

- `pair.test.ts`: 13 pass (12 before, plus the new one).
- `listen.test.ts`: 22 pass (20 before, plus the flag test and a source check that the entry point passes `process.argv.slice(2)`).
- `tsc --noEmit` with the primary checkout's compiler: no error in either changed source file.

Each new test holds the control and the negatives together, as the row asks. The control is the same `main` with no flag (`--root=<dir>` for pair) and a fake Telegram that records its requests: it must reach the fake. The negatives (`--help`, `-h`, an unknown flag, a positional, and `--help` combined with a flag) must leave the fake's request list empty and, for pair, write no chairman file.

Acceptance: `npx rstest run --config scripts/rstest/rstest.config.ts src/messaging/providers/telegram/pair.test.ts src/messaging/listen.test.ts`

Mutation: `args: []` in each parse (argv ignored) -> exactly the new test red in `pair.test.ts` (1 of 13), and in `listen.test.ts` the new test (1 of 22).

## Anything a reviewer should be sceptical of

- **The `--help` of the real entry point is not run by a test.** Spawning `listen.ts --help` from a test would start the real poller if the fix regressed, which is the incident. The source check pins that the entry passes `process.argv.slice(2)`; the row's third done-when (the printed usage after a release, with the listener still `active`) is for after release.
- **`.agent-org/roles/engineer.md` is not in this worktree** (nor in `main`), so the engineer brief was not read; the PR was not opened through `pr:open` from here.
- **`listen` still prints its version line before the usage.** `console.log(toolVersionLine())` runs ahead of `main` for the unit's journal; it is one line and harmless for `--help`.

🤖 Generated with [Claude Code](https://claude.com/claude-code)
