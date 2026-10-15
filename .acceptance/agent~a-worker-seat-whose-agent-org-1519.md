A worker seat that herdr lists with no pane, whose rows are all closed, is ENDED by the tick's teardown, so its workspace closes and `treated N listed agents with no pane as ended` stops repeating. `readAgents` already marks such a seat `paneless` (agent-org#1413) and `endFinishedSpares` now reads that mark: `spareDecision` ends a paneless seat that holds no open row, has held one, and has every row it held read CLOSED. A plain `unknown` seat (one still starting), a paneless seat that still holds an open row, and a paneless seat whose row GitHub could not read are all left running.

Acceptance: `node --test src/packaging/wake-spare-teardown.test.ts`

Mutation: the paneless path switched off (`const paneless = false`) failed test 1 only; the rows-closed check removed failed test 4 only; the open-row check removed failed test 3 only. `src/wake.ts` restored byte-identical each time (`diff` against a copy). Test 1 fails on `main` (`end: false`, no `workspace close`), the other three pass on `main` and guard the cases that must not end.

Measured: `wake-spare-teardown.test.ts` 23 tests pass; the wake, herdr and claim-stall files together (`src/packaging/wake*.test.ts src/wake*.test.ts src/herdr-agents*.test.ts src/claim-stall*.test.ts`) 846 pass, 0 fail; `tsc --noEmit` exit 0.

Not measured here: the live tick. Done-when items 2 and 3 of agent-org#1519 (the two seats gone from `workspace list` after a tick on the release, and the line no longer repeating) need the released host and are the post-merge check.

Closes a11ign/agent-org#1519

🤖 Generated with [Claude Code](https://claude.com/claude-code)
