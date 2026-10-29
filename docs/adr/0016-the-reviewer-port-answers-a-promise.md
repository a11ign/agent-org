# The reviewer port answers a promise, and the gate keeps synchronous forms for row mode

After A11-356 (ADR 0015), the board's sweeps read GitHub without holding the loop. Starting a reviewer still held it about nine times, about 10 s in all, because `ReviewerPort` was synchronous. The atomic reviewer's herdr, git, install, token mint and claim calls were all synchronous spawns on the board's thread (A11-379).

## Decision

Reviewer contract 2.0: every port call that spawns a program answers a promise. These are `start`, `live`, `settled`, `close`, `retire`, `listedPulls`, `repostVerdict`, `reprompt` and `unblock`. `verdictFileOf` reads files only and stays synchronous. Code host contract 3.0: `readReviewClaims` and `writeReviewClaim` answer a promise and run through `deps.execAsync`. `claimHead` awaits its `read` and `write`. The port runs in the board's own process, so the instances it has seen and the heads it started stay in memory. A start, a close or a retire in flight holds its seat: a second call for that seat is refused (a start, a retire) or answers busy (a close) until the first settles. The git work against one clone is done one call after another, as it was when a start was one block, so two starts in one repository do not run `git fetch` and `git worktree add` at the same time.

The gate's checkout, install, mint, spawn and close steps get async forms for the port (`src/wake/reviewer-start-async.ts`). The synchronous forms stay for row mode, which ADR 0002 keeps. The pure parts are shared, and a parity test holds the two forms to the same program calls and answers.

## Considered options

- **A child process per reviewer start**: it would lose the port's in-memory state, the claims seen from other instances. The chairman ruled it out (2026-10-28).
- **Making row mode async too, so each step has one form**: it reaches through `reviewerTarget` into the row-mode tick, which this change does not need.
