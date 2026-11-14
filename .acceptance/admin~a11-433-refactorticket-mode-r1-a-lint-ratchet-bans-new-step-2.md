## What it is

`src/ticket-mode/reviewer-port.ts` no longer makes a synchronous call (A11-433, step 2 of 5), and it leaves `blocking-calls.baseline.json`. Before, `originOf` read a clone the cache missed with `execFileSync("git", …)` on the board thread. Now `warmOrigins` reads the clones' origins asynchronously and returns the reader of what it read. `reviewedRepositoriesOf` and `cloneKeyForRepository` take that reader as a required argument, so no caller can read the origins before they are warmed. Doctor gets them the same way, through `cloneRemotes`. The dependency sweep warms on every sweep, including when a test names its repositories.

The step's named file, `blocking-ledger.ts`, makes no synchronous call: it is the ledger that times them. It was never in the baseline, so this step converts the next file whose call holds the board loop instead.

## Acceptance

- `reviewer-port.ts` is no longer in the baseline, so the real ESLint config (`npm run lint`, and the `npx eslint` line below) now refuses a synchronous call there. `src/packaging/blocking-calls-ratchet.test.ts` still passes: the baseline only shrank.
- `src/ticket-mode/board-thread-sync-guard.test.ts` no longer allows the `git` call of `reviewer-port.ts`.
- `src/ticket-mode/reviewer-port.test.ts`, test "A11-360: cloneKeyForRepository…", checks the following:
  - the reader answers the origin a warming read;
  - a path no warming asked about has no origin, and reading it spawns nothing;
  - an answer is kept for 5 minutes and read again after that;
  - a path that is no clone has none.
- `src/install/doctor.test.ts` checks that the clone-key rows use the injected `cloneRemotes`.

Acceptance:
```bash
bash -c 'set -euo pipefail
npm run typecheck
npx eslint src/ticket-mode/reviewer-port.ts src/install/doctor.ts src/ticket-mode/dependency-updates/board.ts src/ticket-mode/pool-reviewers.ts src/ticket-mode/opened-pulls.ts --quiet
! grep -n "reviewer-port" blocking-calls.baseline.json
! grep -nE "execFileSync|spawnSync|execSync" src/ticket-mode/reviewer-port.ts
AGENT_ORG_HOST= npx rstest run --config scripts/rstest/rstest.config.ts src/packaging/blocking-calls-ratchet.test.ts src/ticket-mode/board-thread-sync-guard.test.ts'
```

The other tests named above need the CI fixture project (`AGENT_ORG_HOST`), so CI's `suite` job runs them.

Mutation: restore `origin/main`'s `src/ticket-mode/reviewer-port.ts` (`git show origin/main:src/ticket-mode/reviewer-port.ts > src/ticket-mode/reviewer-port.ts`). `npx eslint src/ticket-mode/reviewer-port.ts` then fails with the A11-433 ban at the `execFileSync` import and call. The board-thread guard test then fails on the unlisted `execFileSync("git"`.

Consumer-declaration: none. `originOf` was exported only for doctor and the tests in this repository, and no published surface changes.
