The row the tick files for a stuck cause in a repository whose pull requests are not in the primary's tracker is now born in a state: `fileRepositoryRow` creates it with `answer:ceo`, `parked` and `out-of-release` in the one `issue create`, then adds it to the primary's Project and sets Status to Backlog (`gh project item-add`, then `item-edit --field Status --value Backlog`). The dedupe on the title is unchanged and a duplicate is written nothing. A board that refuses, or a project declaring none for the primary, throws after the row is filed, so the tick log says `COULD NOT ESCALATE <ref>: #<n> filed but OFF THE BOARD: <reason>` once.

Evidence (this branch, agent-org worktree, measured): `src/stuck-row-state.test.ts` 5/5 pass. The positive control, the same test against the unmodified `src/wake.ts` from `origin/main`, fails 4 of 5 (the first case on the labels). Mutations, each restored byte-identical and diffed: the board step never run turns 3 red (the board case and both refusal cases), the title look removed turns the dedupe case red alone, the Status written as `Ready` turns the board case red alone. The five other files that import the changed functions (`stuck-escalation-goes-to-ceo`, `stuck-escalation-writes-the-question`, `wake-escalation-answered`, `wake`, `work-gate-stuck-escalation-keyed`) pass 193/193 with this file. The whole suite reads 34 failed of 8326 in 8 files, none of them wake or escalation; those 8 files fail 19 of 145 identically on the unmodified `wake.ts`. `tsc --noEmit` reports only the pre-existing `mjs-ratchet.test.ts` missing-module errors. The suite needs `AGENT_ORG_HOST` pointing at a project declaration to import `wake.ts` at all.

Acceptance: `npx rstest run --config scripts/rstest/rstest.config.* src/stuck-row-state.test.ts`

The row's own form begins `cd /home/agent/repos/agent-org &&`; that is the primary checkout, which stays at a detached older head and holds no `src/stuck-row-state.test.ts` until this merges, so the command is run from the branch's own checkout (the repository root) instead.

Closes a11ign/a11ign#4727

Mutation: board step never run -> 3 red; title look removed -> 1 red (dedupe case); Status written `Ready` -> 1 red (board case); each restored byte-identical.

platform: GitHub's `gh project item-add` and `item-edit` (the calls `row-file`'s `boardAndVerify` makes) are what boards the row; no GitHub project workflow sets a Status on an issue created by `gh issue create`, so the add is explicit.

Net lines: positive in `wake.ts` (+53/-12) and one new test. `row-file.ts`'s `boardAndVerify` was not reused because `row-file` imports `row-claim`, which imports `wake.ts`, so the import would be a cycle; the two `gh project` calls are the whole of it.

After the answer, the row stays open: removing `answer:ceo` leaves a `parked` row with no wait, which `board-truth-audit`'s `parkedWithoutConditions` names to `product-manager`. Nothing in this change closes it, by the row's own Region; that is a follow-up row.

🤖 Generated with [Claude Code](https://claude.com/claude-code)
