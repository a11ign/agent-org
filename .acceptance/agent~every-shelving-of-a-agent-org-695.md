A shelving of a keyed tracker's row is resolved against THAT tracker's rows (a11ign/agent-org#695). **The incident:** `blocking-impact: 4 B4 shelvings name a row or pull request nobody is known to hold` printed on every tick for hours; the four were agent-org#475, #522, #530 and #689, shelved behind agent-org#469 and #521, both open and claimed (`session:worker-agent-org-469`, `session:worker-agent-org-521`). `blockingImpactOrders` merged the keyed repository's shelvings into the home list with no repository, and `resolverOf` looked a bare `#469` up among the home tracker's open rows, where a11ign#469 is a closed pull request.

**What changes.**
- `Shelved` carries `repo` (the tracker its row is in; absent for the home tracker). `work-gate.ts` fills it from each other scope's tracker and hands `resolverOf` each tracker's open rows by repository (`trackers`).
- A bare `#N` in the Region text (`overlaps the Region of #N`) of a shelving that carries a repository is that repository's row first, then that repository's pull request. A home shelving resolves exactly as it did.
- **One deviation from the row's wording, measured:** the pull-request text (`overlaps #N, which already touches`) stays a bare home-repository pull request even in a keyed shelving, because a keyed repository's own pull requests are named `#N in <repo>` (`prName` in `file-overlap-rule.ts`; the live journal shows `agent-org#695: overlaps #694 in a11ign/agent-org`). Reading that bare number as the keyed repository's would attribute it to the wrong pull request.
- Consequences the change would otherwise have introduced, handled in the same file: the deadlock walk reads each tracker's own `blockedBy` edges (`waits.blockersOf(row, tracker)`), and the row write on a held row goes to the keyed repository (`heldIn`), not to the home tracker's row of the same number; it is not made when one holder's held rows are in two trackers.
- The line's text is unchanged and `repeating-lines.allowlist.json` is not touched: the count is 0 when every shelving names something held.

Mutation (each restore byte-identical, a copy in the scratchpad and `diff`): the ref left bare for a keyed shelving (4 red: the three Done-when 2 cases and the incident's row write); the pull-request text read as keyed (1 red); a keyed number falling back to the home rows (1 red); the deadlock walk over the home edges (1 red); the row write always to the home tracker (1 red).

Evidence: `src/blocking-impact.test.ts` 26 of 26 (the original 20 and six new: (a) keyed shelving naming bare #469 attributed to the keyed claim, `unattributed` 0, with the same shelvings counted 3 when the keyed rows are not handed over; (b) the same bare number with no repo resolves to the home row and a keyed one to its own tracker's; (c) a keyed number no open row of that tracker holds is still unattributed, even where a home row of that number is claimed; the pull-request text; the deadlock walk; the row write's repository). `tsc --noEmit` reports only the two `mjs-ratchet.test.ts` errors the main clone has. The whole suite: 32 of 8765 fail, all in 11 files under `src/packaging/` that fail identically on the main clone (26 of 280 in nine of them and 6 of 24 in two, measured there; `mjs-ratchet.test.ts` is the load error above).

Not done: Done-when 3 of #695 is a reading of the live journal after one tick on the merged tool, which cannot be made before the merge.

Acceptance:

```bash
grep -q 'keyed tracker' src/blocking-impact.test.ts && AGENT_ORG_HOST=/home/agent/repos/a11y-witness/.agent-org/host.json pnpm exec rstest run --config scripts/rstest/rstest.config.ts src/blocking-impact.test.ts
```

Closes a11ign/agent-org#695

Outside-Region: .changeset/a-keyed-trackers-shelving-is-attributed-695.md — the entry a project that pins a tag reads.

platform: n/a (no GitHub, pnpm, systemd or git feature beyond the existing `gh issue comment`)

🤖 Generated with [Claude Code](https://claude.com/claude-code)
