The gate now offers ready rows in one hierarchy: a `priority:chairman` row first (verified against the label's actor, offered whatever the product share, and it starts a fresh engineer), then `priority` rows (exempt from the #3820 product floor), then milestone rank (`offerMilestones` in `.agent-org/project.json`, absent means no ranking), then row number. A chairman label from anyone else is ignored, logged on stderr and reported to `ceo`. A chairman row that overlaps another chairman row or an open PR closing one is shelved and reported, not offered; one that overlaps a plain in-progress row is offered and the holder is told to keep off the files and rebase. If the label history cannot be read, the row is not offered.

Evidence: `work-gate-offer-hierarchy.test.ts` 9/9 pass, one case per Done-when line, each turned red by a mutation and restored byte-identical (chairman exemption removed, `startFresh` removed, actor check removed, B4 chairman verdict removed, `priority` exemption removed, milestone sort removed, floor removed). The order-text pin `wake-order-shape.test.ts` caught a date literal in my new prompt and passes after removing it; the 431 tests of that file plus every `work-gate*.test.ts` pass. The full suite reads 38 of 7568 failed in 13 files; each of those 13 files, run alone on a clean checkout of `main`, fails with the same count, so none is caused by this change. `pnpm run typecheck` shows only the pre-existing `@a11ign/toolchain/mjs-ratchet` errors. Not in this PR: `wake.ts` honouring `startFresh` (outside the Region), the a11ign `project.json` ranking (Done-when 2, after #4520) and the live reading (Done-when 3).

Acceptance: `bash -c 'cd "$AGENT_ORG_TOOL" 2>/dev/null || cd ~/repos/agent-org; npx rstest run --config scripts/rstest/rstest.config.ts src/work-gate-offer-hierarchy.test.ts'`

Closes a11ign/a11ign#4524

platform: n/a (gate ordering logic, no worker involved)

🤖 Generated with [Claude Code](https://claude.com/claude-code)
