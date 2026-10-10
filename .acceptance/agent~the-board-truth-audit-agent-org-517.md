The board-truth audit now asks a ninth question, `roadmap-value`: an open row under a roadmap epic whose own `Roadmap` value is absent, or different from its epic's, is a finding that names the row, the epic and both values, so the fix is one `gh project item-edit`. `row-file` enforces the value at filing and cannot see a row boarded by hand, linked as a sub-issue afterwards, or whose epic's value changed; this is the net under it.

What changes, by the row's items:

1. **`readBoardFacts`** reads, per open row, its parent and the `Roadmap` value of the row and its parent on each project the row is boarded to, to two levels, as the backfill was (`readRoadmaps` in `src/board-truth-audit.ts`). One aliased GraphQL request per 50 rows per tracker: `gh issue list --json` has `parent` and `projectItems` but not the field's value, so GraphQL `fieldValueByName(name: "Roadmap")` is the only way, and the shared GraphQL pool (#4148) is why it is one aliased request and not one call per row (inferred from the query's shape: about 2 points per tracker per tick; not measured against the quota).
2. **`boardTruthAudit`** gets the question in `QUESTIONS` and `READERS`, and `boardTruthTable` renders it. It works in any repository: the keyed tracker is asked too and its finding carries its key.
3. **The finding** reads `` `Roadmap` on project a11ign/1 | no `Roadmap` value, and its epic a11ign/a11ign#4627 has `Agent spend (Haiku/Jev)`: `gh project item-edit` it to `Agent spend (Haiku/Jev)` ``, and says `(through <parent>)` when the value came from the grandparent.
4. **ABSENCE IS NOT PROOF**, as for every question here: a read that was refused, misshapen or cut short (`projectItems` `totalCount` above the nodes returned) makes the question UNREAD (`roadmaps: null`), counted as not read and never as agreeing; a caller that does not ask (`roadmaps` undefined) is NOT ASKED.

**Two judgement calls the row left open, so they are named.**
- The comparison is PER PROJECT. The field is the Project's, and a row is held to the value its epic has on a Project THE ROW IS BOARDED TO. An epic with a value on project 2 and none on project 1 asks nothing of a row on project 1. A row boarded to no project, or not to the epic's, has no item to read and is not judged here: that is a different disagreement (a row off the board), and calling it a missing value would be a guess.
- "Under a roadmap epic" is read as: the parent, else the grandparent, has a non-empty value on that project. The nearest epic with a value wins; three levels up is not looked at.

Acceptance: `AGENT_ORG_TOOL=/home/agent/repos/wt-agent-org-517 bash -c 'cd "$AGENT_ORG_TOOL" 2>/dev/null || cd ~/repos/agent-org; pnpm exec rstest run --config scripts/rstest/rstest.config.ts src/board-truth-audit-roadmap.test.ts'`

Closes a11ign/agent-org#517

Outside-Region: src/board-truth-audit.test.ts — adding the ninth question and the aliased read broke three existing assertions there (the emptiness control that names the questions, the reader's call-shape assertions, and the tick's `clear`); each is changed minimally and the file gains a #517 fixture in the emptiness control.

platform: GitHub GraphQL `fieldValueByName` on `ProjectV2Item` and `Issue.parent`, both used by the same reads elsewhere in this tool; the live run below is the check that they answer as the query expects.

Evidence (this branch, `/home/agent/repos/wt-agent-org-517`, all measured):
- the Acceptance command passes, 10 tests in 1 file, under the real a11ign `host.json` and under a single-tracker scratch declaration. The row's cases: the POSITIVE CONTROL (one row with no value and one with the wrong value are found, a row with the right value is not); the finding names the row, the epic and both values; the comparison is per project; a row under no epic, or under an epic with no value, is not asked; two levels and no further; unread and not-asked; a keyed tracker's finding carries its key; and `readBoardFacts` parsing (cross-repository parent, text value, 50 rows to a request, refused/misshapen/cut-short read is `null`).
- `src/board-truth-audit.test.ts` with the roadmap file: 55 tests pass under the single-tracker scratch declaration. Under the real a11ign `host.json`, 2 of the 45 in `board-truth-audit.test.ts` fail (`the reader: ...` and `tick: the open rows are the tick's own ...`) because that host declares a keyed tracker; the same 2 fail the same way on `HEAD~1`, a clean checkout of the base (measured by running the unmodified file there), so this change did not cause them.
- `pnpm run typecheck` reports only the two `src/packaging/mjs-ratchet.test.ts` errors that the base has; none is in a file this change touches. The repo has no `lint` script.

Mutation (each a one-line change to `src/board-truth-audit.ts`, restored byte-identically from a copy and confirmed with `cmp`; `src/board-truth-audit-roadmap.test.ts`, 10 tests):
- the question not in `READERS` (never fires): 8 of 10 red, the positive control among them. **This is the row's "positive control fails without the new question".**
- the value never compared, so a row with the right value is found (always fires): 3 of 10 red.
- the epic read one level only, not two: 1 of 10 red.
- the comparison not per project (the first value of any project): 1 of 10 red.
- restored: 10 of 10 pass.

Live audit, run once against the real board at this head (`gh` as `a11ign`, both trackers, read-only; output verbatim):

```
tracker (home): 63 open rows, roadmaps 63 read
tracker agent-org: 32 open rows, roadmaps 32 read
### Board against reality, 2026-10-10

**4 disagree** -- NOT READ, so not counted as agreeing: wait-already-true -- NOT ASKED: agent-org: wait-already-true

| row | question | field to fix | what disagrees | to |
|---|---|---|---|---|
| #4623 | roadmap-value | `Roadmap` on project a11ign/2 | no `Roadmap` value, and its epic a11ign/a11ign#4437 has `Self-healing org`: `gh project item-edit` it to `Self-healing org` | product-manager |
| #4756 | roadmap-value | `Roadmap` on project a11ign/1 | no `Roadmap` value, and its epic a11ign/a11ign#4627 has `Agent spend (Haiku/Jev)`: `gh project item-edit` it to `Agent spend (Haiku/Jev)` | product-manager |
| #4756 | roadmap-value | `Roadmap` on project a11ign/2 | no `Roadmap` value, and its epic a11ign/a11ign#4627 has `Agent spend (Haiku/Jev)`: `gh project item-edit` it to `Agent spend (Haiku/Jev)` | product-manager |
| #4821 | duplicate-or-superseded | state (open) | title is a near-duplicate of open #4623 | product-manager |
roadmap-value findings: 3
```

Rows the live audit found, **listed and not fixed by this pull request** (the row says so; the owner is `product-manager`):
- **#4623** — no `Roadmap` value on project a11ign/2, its epic a11ign/a11ign#4437 has `Self-healing org`. Caveat: it is set correctly on project a11ign/1 and unset on 2, so this is the per-project rule at work and not a row with no value anywhere.
- **#4756** — no `Roadmap` value on a11ign/1 or a11ign/2, its epic a11ign/a11ign#4627 has `Agent spend (Haiku/Jev)`. Two findings, one row.
- Found by the same run and not this question: **#4821**, a near-duplicate of open #4623 (`duplicate-or-superseded`); and `wait-already-true` NOT ASKED for the keyed tracker, as before this change.

I read #4623 and #4756 directly through GraphQL after the run and both showed the value the audit reports (measured), so the findings are not an artefact of the reader.

Not done here, and said so: the audit prints the findings; nothing sets a value. Project items are per project, so one `gh project item-edit` is needed per finding.

Net lines: positive, 280 insertions and 11 deletions across 4 files (a reader, a pure question, a test file); no function was added where an existing one could take the case.

🤖 Generated with [Claude Code](https://claude.com/claude-code)
