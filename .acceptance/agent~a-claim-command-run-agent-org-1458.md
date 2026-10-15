A claim command run from a copy of `src/` outside a git work tree is the stale-rule guard unable to ask, not a failed claim. `stale-rule-guard.ts` prints `CANNOT ASK whether this checkout's copy of the rule is current: <dir> is not inside a git work tree`, and `CLAIM_REFUSAL_TEXTS` now lists that text as `claim-guard-held` (no class, no repeat), placed before the generic `CANNOT ASK` entry, which stays `claim-refused`. A scratch copy's run (the usual `scratchpad/base/src/row-claim` check of `main`) no longer counts as a failure of the claim path, and `readClaimRefusals` still counts it beside the failures, so signal 26 still sees it.

The other `CANNOT ASK whether this checkout's copy of the rule is current` texts (`origin/main` unresolvable, the pathspec matching nothing, the newest release not resolvable) stay `claim-refused`: `CANNOT_ASK_NO_HISTORY` in the test is the negative control.

Acceptance:

```bash
node --test src/row-claim-refusal-kind.test.ts
```

Closes a11ign/agent-org#1458

Mutation, each file backed up to the scratchpad with `cp`, changed, run, restored with `cp`, and proven byte-identical with `cmp`:
- A: the new `is not inside a git work tree` entry removed from `CLAIM_REFUSAL_TEXTS`: 2 red (the POSITIVE CONTROL that the no-tree refusal writes `claim-guard-held`, and the NEGATIVE CONTROL that a guard refusal is not a `claim-refused` line).
- B: `claimRefusalKind` made to return the guard kind for every refusal: 2 red (the POSITIVE CONTROL for the failure path, and the NEGATIVE CONTROL).

Measured:
- Acceptance, verbatim (`node --test src/row-claim-refusal-kind.test.ts`, Node v24.21.0): `ℹ tests 7`, `ℹ pass 7`, `ℹ fail 0`.
- `pnpm run typecheck` exits 0.
- Related row-claim suites, each run on its own: `row-claim` 35/35, `row-claim-refusal-cause` 3/3, `row-claim-refusal-record` 5/5, `row-claim-worktree-cap` 4/4, `row-claim-writes` 11/11, `work-gate-claim-refusal-keyed` 4/4, `claim-stall-git-reads` 8/8, `work-gate-claim-stalled` 129/129, `row-claim/lane-one-shot-claim` 11/11, `sweep-window-overrun-kind` 10/10.

Limits, named:
- The no-tree text is matched by its first line, so the `.*` in the pattern accepts any directory. A scratch copy that runs the INSTALLED variant (`CANNOT ASK whether the INSTALLED copy`) is unchanged and stays `claim-refused`, as before.
- The ledger write still goes to the HOST ledger from a scratch copy (`stateEntryPath`). That is out of scope for this row, per its Region.

platform: linux, Node v24.21.0. The acceptance test reads source text and calls the classifier; it reads no `gh`, no host state.

🤖 Generated with [Claude Code](https://claude.com/claude-code)
