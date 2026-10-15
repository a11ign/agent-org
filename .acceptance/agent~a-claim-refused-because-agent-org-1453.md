A claim refused because another session already holds the row (`is already claimed by `), or because its `` `Waiting-for: .+` is not yet true `` line is unmet, is the claim guard working. `row-claim.ts` writes both as `claim-guard-held`: no class and no repeat, as the worktree cap, a B4 overlap and the rate limit already are. Signal 26 still counts them beside the failures through `readClaimRefusals`. A `CANNOT ASK whether this checkout's copy of the rule is current` refusal stays `claim-refused` (its negative control).

The refusal texts are no longer a bare regex list. `CLAIM_REFUSAL_TEXTS` (exported from `src/row-claim.ts`) lists every refusal text the file can print once, beside its kind, and `claimRefusalKind` takes the first entry that matches, defaulting to `claim-refused`. `src/row-claim-refusal-kind.test.ts` reads the refusal literals `row-claim.ts` builds (the `reason:` and `refusal:` strings on a claim's refusal path) and fails the build for any that no entry names. The scan is the test's own list-plus-source check, so an unlisted refusal is a red build, and the positive control shows the same check going green once it is listed.

Acceptance:

```bash
node --test src/row-claim-refusal-kind.test.ts
```

Closes a11ign/agent-org#1453

Mutation, each file backed up to the scratchpad with `cp`, changed, run, restored with `cp`, and proven byte-identical with `cmp`:
- A: the two new guard entries (`is already claimed by `, `Waiting-for` unmet) removed from `CLAIM_REFUSAL_TEXTS`: 3 red (the POSITIVE CONTROL that the guard writes `claim-guard-held`, the NEGATIVE CONTROL, and the real-file scan, since those two literals are then unclassed).
- B: an unlisted refusal literal appended to `src/row-claim.ts` (`reason: "an unlisted probe refusal"`): 1 red (the real-file scan, `every refusal literal row-claim.ts builds is classed beside its kind`). The other six stay green.
- C: `claimRefusalKind` made to return the guard kind for every refusal: 2 red (the POSITIVE CONTROL for the failure path, and the NEGATIVE CONTROL).

Measured:
- Acceptance, verbatim (`node --test src/row-claim-refusal-kind.test.ts`, Node v24.21.0): `ℹ tests 7`, `ℹ pass 7`, `ℹ fail 0`. Full output in the engineer's scratchpad.
- `pnpm run typecheck` exits 0 with no output.
- Related row-claim suites, each run on its own: `row-claim-refusal-cause` 3/3, `row-claim-refusal-record` 5/5, `claim-refusal-storm` 13/13, `row-claim` 35/35, `row-claim-worktree-cap` 4/4, `work-gate-claim-refusal-keyed` 4/4, `row-claim-writes` 11/11.
- `pnpm test` (rstest) on this head: `VERDICT fail: 112 of 11616 tests failed in 699 files`. The same run with the HEAD copy of `src/row-claim.ts` swapped in (and restored byte-identical) gives `116 of 11616`: those 112 plus 4 red tests in `src/row-claim-refusal-kind.test.ts`, which cannot pass against HEAD because `CLAIM_REFUSAL_TEXTS` does not exist there. The per-file failing lists are otherwise identical. The 112 are in `work-gate*`, `org-health`, `pr-owner-*`, `queue-stalled` and similar, none of them row-claim; they fail at HEAD on this host too, so they are not this change's.
- No `lint`, `verify` or `test:org` script exists in this worktree's `package.json`, so those were not run.

Limits, named:
- The scan reads refusal literals in `src/row-claim.ts` only. A refusal built in a variable (`reserved`, `laneRefusal`, `decision.reason`, a stale-rule text) or in another module is not read, and neither is an `Error` message reaching the ledger. Those are classed where the variable is built, or are still `claim-refused` by default.
- A composite reason that opens with `${` is skipped, because its text is classed where the variable is built (lines around 975, 1201, 2227, 2369).
- `lost a race to …` (a lost claim race, `claimed: false`) stays `claim-refused`, as before this change. It is arguably a guard refusal, but the row does not name it, so it is left unchanged; the owner should decide.

platform: linux, Node v24.21.0. The acceptance test reads source text and calls the classifier; it reads no `gh`, no host state.

🤖 Generated with [Claude Code](https://claude.com/claude-code)
