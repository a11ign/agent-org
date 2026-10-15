A gate tick whose only unread lanes were skipped by pacing exits `PACED` (4) and says `N lane(s) skipped by pacing, none refused`; the tick says `lane(s) skipped by pacing, none refused` and not `one lane could not be read`. One refused lane keeps `PARTIAL` (3) and both old lines. `src/repeating-lines.allowlist.json` allowlists the two all-paced lines and not the refused ones.

Acceptance:

```bash
cd ~/repos/agent-org && node --test src/packaging/wake.test.ts src/packaging/gate-graphql-pacing.test.ts
```

Closes a11ign/agent-org#1414

Revert: restore `PARTIAL` as the only exit of `exitPartial`, drop `PACED` from `EXIT` and `GATE`, and drop the allowlist entry; the tick then logs `one lane could not be read` for a paced skip again.

Mutation: `exitPartial`'s all-paced branch disabled (`if (false)`) -> 2 red (the exit/wording test and the allowlist test); the allowlist pattern widened to `^PARTIAL: .*` -> 1 red (the refused line is matched); the all-paced pattern made never to match -> 1 red. Each restored from a copy and `diff`ed byte-identical. The new tests did not exist before the change, so none could pass without it.

Measured: the Acceptance printed `ℹ tests 168`, `ℹ pass 168`, `ℹ fail 0` at this head. `pnpm run typecheck` exited 0. `repeating-lines`, `machinery-canary` and `work-tick-crash-exit` printed `ℹ fail 0`. `work-gate.test.ts` printed 37 failures here and on a clean checkout of origin/main (the same 37 names; `diff` of the failing-name lists was empty once `#912`'s exit-contract pin was updated for `PACED`), so they are not this change's. `pnpm run verify` was not run.

Outside-Region: `src/packaging/work-gate.test.ts` (its `#912` test pins `EXIT` as four exact states, which now has a fifth) and `.changeset/`.

Not done, and why: #1401 (a paced skip read as a refusal in claim-stall and OUTAGE) is the row's own "related, not this row"; left to its owner. The tick's line says `lane(s)` without a count, because the gate hands the tick an exit code only.

platform: checked the exit code the tick already reads from the gate child (`gate.status`) before adding a channel; a second code rides it, no new file or parser.

🤖 Generated with [Claude Code](https://claude.com/claude-code)
