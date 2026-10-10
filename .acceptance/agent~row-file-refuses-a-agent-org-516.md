`row-file` refuses a row filed under a roadmap epic that carries a `Roadmap` value unless the filing names `--roadmap=<option>`, and sets that value on the row's item after boarding it, reading it back (a11ign/agent-org#516, chairman direction on a11ign#928).

Acceptance:
```bash
pnpm exec rstest run --config scripts/rstest/rstest.config.ts src/row-file-roadmap.test.ts
```

The row's command is `bash -c 'cd "$AGENT_ORG_TOOL" 2>/dev/null || cd ~/repos/agent-org; pnpm exec rstest run --config scripts/rstest/rstest.config.ts src/row-file-roadmap.test.ts'`. The primary clone carries the new test only after the merge, so the command above is the same one run in the PR's own tree, with `AGENT_ORG_HOST` set to a11y-witness's `.agent-org/host.json`. Printed: `VERDICT pass: 15 tests in 1 file`.

Mutation:
- Each mutant was applied with a script to `src/row-file.ts`, run against `src/row-file-roadmap.test.ts` (15 tests), and restored from a copy (`diff` identical afterwards; never `git checkout --`).
  - POSITIVE CONTROL, the refusal removed (an absent `--roadmap=` is accepted): 2 fail, the control (`a parent whose epic has a Roadmap value and no --roadmap= is REFUSED`) and the parent-spelling test. The control files the row instead of refusing, which is the defect.
  - the epic's value is never consulted (flag absent always passes): 2 fail, the same two.
  - a `--roadmap=` is dropped under an epic with no value: 3 fail, including `a --roadmap= given under an epic with no value is still checked and set`.
  - no read-back (a set that did not land reads as success): 1 fails, `a set that the read-back does not confirm is a failure too`.
  - the value is never set: 4 fail (the filing, the failed set, the read-back, the differing option).

Live filing (done-when 2), run from this branch's `src/row-file.ts` against a scratch epic, a11ign/agent-org#643, whose `Roadmap` was set to `Clean boundaries` on Project 2. Refusals, nothing filed, exit 1 each:
```
$ node src/row-file.ts --title "SCRATCH child ..." --body-file body.md --session=worker-agent-org-516 --tracker=agent-org --label out-of-release --parent=643
row-file: REFUSING to file -- its epic a11ign/agent-org#643 carries `Roadmap` = `Clean boundaries`, and `--roadmap=<option>` is absent. Every row filed under a roadmap epic is given its value (a11ign#928); name one of: `v3 — outside adopter`, `Agent spend (Haiku/Jev)`, `Self-healing org`, `Manager redesign`, `Clean boundaries`. Nothing was filed.
exit=1
$ ... --parent=643 --roadmap=Sideways
row-file: REFUSING to file -- `--roadmap=Sideways` names no option of the project. [same list] Nothing was filed.
exit=1
$ ... --roadmap="Clean boundaries"        (no --parent)
row-file: REFUSING to file -- `--roadmap=` is given with no `--parent=`. The Roadmap value comes from the epic a row is filed under, so a row with no epic has nothing to take it from. Pass `--parent=<epic>`, or drop the flag. Nothing was filed.
exit=1
```
The successful run, and the board read back after it (`parent`, Project 2 `Roadmap` and `Status` of the new row):
```
$ ... --parent=643 --roadmap="Clean boundaries"
https://github.com/a11ign/agent-org/issues/644
exit=0
{"parent":{"number":643},"projectItems":{"nodes":[{"fieldValueByName":{"name":"Clean boundaries"},"project":{"number":2},"status":{"name":"Backlog"}}]}}
```
#643 and #644 are closed as not planned.

Suite: `pnpm run typecheck` shows the same 2 errors as `HEAD`, both in `src/packaging/mjs-ratchet.test.ts` (`@a11ign/toolchain/mjs-ratchet` not resolvable in this tree), none in a file this row touches. The 40 test files that mention `row-file` ran 1775 tests with 9 failing, all in `src/packaging/row-file.test.ts` and `src/packaging/row-file-refuses-duplicate-title.test.ts`; the same 9 fail identically with `HEAD`'s `src/row-file.ts` swapped in (this checkout resolves the home project as agent-org, so those tests expect another tracker), so none is new.

Decisions, because the row did not fix them:
- An epic with no `Roadmap` value changes nothing, EXCEPT that a `--roadmap=` given anyway is checked and set rather than ignored (an ignored flag that reports success is what `refuseUnknownFlags` exists to prevent).
- A `--roadmap=` that names a different option than the epic's is allowed and prints a WARNING naming both; the row said "naming one of the project's options", and a refusal on mismatch would be a rule the row did not state.
- An epic that cannot be READ is a refusal, never "no value". A board with no `Roadmap` single-select field is refused before anything is filed.
- The field and options are read from the tracker's board (the board the value will be set on); the epic's value is read from the epic's own items, preferring the one on the row's board.
- A failed set is exit 2 with the row already filed (the same class as the other post-create failures), and the message names the hand command.
- `--roadmap` is matched case-insensitively against the project's option names as a convenience; the canonical name is what is set.

What this row does NOT do: it reads no epic's link to its child (`gh`'s `--parent` already makes the sub-issue link), and the detector for rows that slipped through is the sibling board-truth audit row.

platform: gh `--parent` already links the sub-issue; the field is set with `gh project item-edit`, and the project's own field options are read, not copied.

Closes a11ign/agent-org#516

🤖 Generated with [Claude Code](https://claude.com/claude-code)
