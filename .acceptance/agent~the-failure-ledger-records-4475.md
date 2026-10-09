The failure ledger records a keyed repository's red `main` as a `main-red` event beside the primary's, from the reading `scopeTick` already holds (a11ign/a11ign#4475, move 1a follow-on of epic #4437).

- `src/work-gate.ts`: `scopeTick` returns the `trunkRed` it was given (`undefined` for a scope with no code repository, `null` for a green or unreadable `main`); `main()` hands `others.map((tick) => tick.trunkRed)` to `recordTickFailures` as `keyedTrunkReds`. No second ask of GitHub: it is the reading `otherScopeTicks` made once per repository for the scope's order.
- `src/failure-recorders.ts`: `recordTickFailures` appends `keyedTrunkReds.flatMap(mainRedEvents)` after the primary's event. `mainRedEvents` already names the repository in the ref (the run's URL, or `<repo>/runs/<id>`), so two repositories' reds with the same run number are two refs, and the same red run on two ticks is one line (`recordFailures` dedupes on the ref). `null` and `undefined` yield no event.
- `src/failure-ledger.test.ts`: six tests, each with its twin in the same body (see Acceptance).

Outside-Region: none beyond the changeset the Region names.

Acceptance:
```bash
npx rstest run --config scripts/rstest/rstest.config.ts src/failure-ledger.test.ts
```

Closes: a11ign/a11ign#4475

Verified (measured in this worktree, `AGENT_ORG_HOST=/home/agent/repos/wt-4475/.agent-org/host.json`): `failure-ledger.test.ts` 17 pass (11 before, 6 added). Full `pnpm test`: 33 failing of 7631 here, 33 failing of 7625 on a clean `origin/main` worktree run the same way (the difference is the six new tests; the failures are `src/packaging/*` and `src/board-truth-audit.test.ts`, which need a full project checkout this host does not give them). `tsc --noEmit`: only the two existing `src/packaging/mjs-ratchet.test.ts` errors. agent-org has no lint script.

Mutation, three single-line mutations against `failure-ledger.test.ts`, each file restored byte-identical (`cp` before, `diff` after): (1) never fires, `keyedTrunkReds.flatMap(mainRedEvents)` removed from the recorder: 4 tests red; (2) the wiring drops the reading, `scopeTick` returns `trunkRed: undefined`: 1 test red (the wiring test, and no other); (3) always fires, a `null` reading turned into a red event: 1 test red (the `null`/`undefined` test, and no other).

Done-when 2 is NOT met by this PR and is said so: the real `work:tick` has no dry-run mode and would perform its actions, so it was not run from this worktree. The first live tick after the merge appends a line only if a keyed repository's `main` is red then; the unit test is the evidence otherwise.

platform: checked whether GitHub or git record a red `main` per repository over time; neither keeps a count a second red can be compared with, so the existing `failure-ledger` carries it. Net: no new module, no new read; the reading already taken is passed on.

🤖 Generated with [Claude Code](https://claude.com/claude-code)
