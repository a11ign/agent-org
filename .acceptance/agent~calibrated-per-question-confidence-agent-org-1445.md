The decision provider reads calibrated per-question confidence floors from `.agent-org/confidence-floors.json` (`{ "<use>.<question>": 0..1 }`), beside the switches file and not in it. A question's floor is its own `minConfidence` when it has one (engineer-route's `0`, #4875, still wins), then its calibrated floor, then the host's floor. The calibrated floors are the ones `calibrateFloors` (`src/confidence-floors.ts`, #1205) sets, which are already on main. An absent file means no calibrated floors, quietly. A file that cannot be used (unreadable, not JSON, not an object, or a value that is not a number from 0 to 1) means none either, with ONE diagnostic line naming the file and never its content. `decisions.json` is not touched: it still holds booleans only, so a number there would still switch every use off.

Acceptance:

```bash
cd /home/agent/repos/wt-agent-org-1445 && npx rstest run --config scripts/rstest/rstest.config.ts src/decision-provider.test.ts src/engineer-route.test.ts
```

Closes a11ign/agent-org#1445

Mutation, each file backed up to the scratchpad with `cp`, changed by one exact string replace (one occurrence required), run, restored with `cp`, and proven byte-identical with `cmp`. Each run is `src/decision-provider.test.ts` (24 tests):
- A: the calibrated lookup `floors.get(\`${use}.${name}\`)` replaced with `undefined`: 1 red, the POSITIVE CONTROL "a calibrated floor above the host's sends an answer between them to the fallback; one below keeps it; another use's floor is not this one's".
- B: precedence swapped to `calibrated ?? question.minConfidence ?? floorDefault`: 1 red, "a question's own minConfidence beats its calibrated floor" (the precedence control).
- C: the value range check (`!(v >= 0 && v <= 1)`) dropped so only the type is checked: 1 red, "no calibrated floors file, or one that cannot be used, changes nothing" (the malformed-file control).

origin/main control: the new `decision-provider.ts` is replaced by main's, the same test file run: 2 of 24 red, "a calibrated floor above the host's ..." and "no calibrated floors file, or one that cannot be used ...". The other two new tests pass on main BY DESIGN, since main never reads floors, so they guard the precedence and the decisions.json trap rather than new behaviour: "a question's own minConfidence beats its calibrated floor" and "the floors are not read from decisions.json". The existing cases (including the boolean-only switches file) pass on both trees.

Measured:
- Acceptance, verbatim (`npx rstest run ...` above, run from the worktree): `VERDICT pass: 102 tests in 2 files`, exit 0. The row's `cd ~/repos/agent-org` is a detached checkout that is not on this branch, so the command was run from this worktree instead.
- `pnpm run typecheck` (`tsc --noEmit -p tsconfig.json`) exits 0.
- `pnpm run lint` is not runnable here: this package has no `lint` script (ERR_PNPM_NO_SCRIPT). Not reported as passing.
- `engineer-route.ts` and `engineer-route.test.ts` are unchanged: `decide` already has the use and question names, and the production callers already pass `switchesPath`, so the floors file is found from it (row item 2).

platform: linux, Node v24.21.0

🤖 Generated with [Claude Code](https://claude.com/claude-code)
