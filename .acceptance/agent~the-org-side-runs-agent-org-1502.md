The org side runs an agent pull request's acceptance command, same-repository agent branches only, and its verdict gates arming (a11ign/agent-org#1502, receiving side of a11ign#5460, ADR 0045 cut c).

Acceptance:
```bash
node --test src/acceptance-commands.test.ts
```

Measured: the command above printed `ℹ tests 18 / ℹ pass 18 / ℹ fail 0` at this head (nine existing tests, nine new, `(1502 a)` to `(1502 h)`). `pnpm run typecheck` exits 0. `src/packaging/acceptance-commands.test.ts` (307) and `src/packaging/board-snapshot-scope.test.ts` (28) pass. The affected set (`rstest run --changed=origin/main`) printed `VERDICT fail: 109 of 8577 tests failed in 495 files`; the same 25 failing files run with the four changed source files swapped for `HEAD`'s printed `109 of 1077`, and the failing test names are identical (`comm` over `LC_ALL=C sort -u` of both, empty both ways). They are the environment's: `gh` rate limits and a missing `AGENT_ORG_HOST`. The first draft imported `review-trust.ts` into `acceptance-commands.ts` and that was a real regression (two tests, the #621 self-reference pin and `board-snapshot-scope`, charged the file a token); the trust decision is now injected, and both pass.

Mutation: each applied to one file, run over `acceptance-commands.test.ts`, restored from a copy and compared byte-identical. Fork check never fires: `(1502 a)` goes red. Fork check always fires: `(1502 a)`, `b`, `c`, `c2`, `e`, `h` go red (the eligible controls). Branch rule never fires: `a`, `b`, `h`. Author rule never fires: `a`, `b`, `e`, `h`. A stale merge ref accepted: `d`. Verdict head not compared: `f`. A `fail` arms: `f`, `h`. The switch ignored: `h`.

Outside-Region: `src/work-gate/tick.ts`. The row names `acceptance-commands.ts` and `pr-orders.ts`; the arming decision is `readArmingOf` and `settleUnarmedPrs` in `tick.ts`, which the verdict cannot reach without a call site there (`gateUnarmedOnAcceptance`, one call and `withWithheld`, switched off by default). `.changeset/` carries the release note.

Not done: (a) Done-when's "has run once against a real a11ign agent pull request, the run named on a11ign#5460" is NOT done and cannot be from a worktree: it needs the host gate with `A11IGN_PR_ACCEPTANCE_BY_GATE=on` and a pull request of a11ign. The switch is off, so merging this changes no live behaviour. (b) The fork case is shown by a real process on a fixture merge commit, `(1502 e)`: the same command writes a marker file for the agent pull request and writes none for the fork's. (c) `A11IGN_ACCEPTANCE_REPO_ROOT` (default: the tick's cwd) must be a clone with an `origin` that serves `refs/pull/<n>/merge`; that is assumed from how the gate already runs `gh`, and was not exercised. (d) a11ign's own `acceptance` job and `reusable-acceptance.yml` are unchanged, and are a11ign#5460's half. (e) A `Closes` check, `Mutation:` and the other body reports run over the body the gate read from the pull request list.

platform: GitHub already computes `isCrossRepository` and the `refs/pull/<n>/merge` ref; both are used as given and nothing re-derives either.

Consumer-declaration: none -- a project's workflow runs `acceptance-commands` as before and the new gate is off unless the host sets the variable.
