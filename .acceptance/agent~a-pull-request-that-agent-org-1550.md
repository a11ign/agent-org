Acceptance:

```bash
node --test src/merged-row-open-incident.test.ts
```

A pull request that is a STEP of a row, and says the row stays open, is no longer read as that row's deliverable when it writes a `Part of` or `Refs` line naming that row. `src/merged-row-open-incident.ts` read every row named in an opt-out reason as finished by the pull request, so a step such as a11ign/a11ign#5538 (opt-out reason naming `#5459 to #5462`, with `Part of #5462` added) filed a false `row-not-finishable` incident for #5462. The step line now frees the row it names from that reason. A closing list is never filtered, and a row the step line does not name is still the deliverable.

The rule is written where authors learn the closing line: the pull request template's guidance comment, which tells a step to keep its opt-out line and also write a `Part of a11ign/a11ign#N` (or `Refs`) line naming each row it advances.

The row's controls (a)-(e) are the test file's first four new tests, run by the command above:

- (a) the step-line test, with a11ign/a11ign#5538 as it stands and with the line added (its twin is without the line). Red on `main`.
- (b) the twin: the same body without the line is still an incident.
- (c) a closing list is never freed by a `Part of` line.
- (d) a `Part of` line frees only the row it names; the reason's other row is still the deliverable.
- (e) `Refs` is read as `Part of`; a reference in prose with neither word, or the word inside the reason, is not a step.

Measured: `node --test src/merged-row-open-incident.test.ts` prints `ℹ tests 28`, `ℹ pass 28`, `ℹ fail 0` at this head. Against `main`'s reader, the three controls that depend on the step line go red and the other 25 pass. Five mutants of the new reader each turn at least one control red, and the reader is restored byte-identical after each.

Closes a11ign/agent-org#1550

Outside-Region: .github/PULL_REQUEST_TEMPLATE.md — the row asks for the step rule in the file that teaches the closing line; agent-org has no rules file for that (`src/packaging/rules-files.ts`), so the PR template, the file authors read for it, carries one sentence.

`pnpm run typecheck` exits 0.

`pnpm test` (the whole suite): 11,883 tests; the run had 114 failures in 27 files. One of them, `close-rows-full-form`, was my first draft of the template breaking the closing parse; that is fixed and the file passes 11 of 11. The other 113 (26 files) fail identically with `main`'s reader in place, so the reader is not their cause. They are environmental and unrelated to this change: GitHub 502s in the work-gate reads, and a host-config placeholder in `host-install-agent-org-launcher`.

Host step, not run here: `host:install` is the host's step once this lands; the worker does not run it.

Assumption, noted in place of a question: agent-org carries no rules file that teaches the closing line (its `src/packaging/rules-files.ts` says so), so the rule sentence lives in `.github/PULL_REQUEST_TEMPLATE.md`, the file that tells authors how to write it.

Residual: a11ign/a11ign#5538's opt-out reason also names #5459. A `Part of #5462` line frees only #5462, so #5459 is still read as that body's deliverable if it merges while #5459 is open. The template asks a step to name each row it advances, which is the fix at the author's end.

## What changes, and why

The daily pass read every row an opt-out reason named as finished by that pull request. A step of a row (its reason says the row stays open) therefore counted as the row's finish and filed `row-not-finishable`. The step line is the author's own way to say "this advances that row and does not finish it", so the reader now honours it, for that row only.

## Platform first, deleting first

platform: checked the existing `extractClosesDeclaration` and `closesReferences` in `src/acceptance-commands.ts`; neither reads a step line, and a closing list must keep its current meaning, so the step line is parsed in the reader that reads the reason.

Net lines: +18 non-test (reader +13 and -2, changeset +5, template 1 swapped for 1 = 0); the test file adds 39 lines. The reader needs the step parse because a reason alone cannot tell a step from a finish.

## How you verified it

- `node --test src/merged-row-open-incident.test.ts`: `ℹ tests 28`, `ℹ pass 28`, `ℹ fail 0`.
- Against `main`'s reader: three step-line controls red, 25 pass.
- Five mutants of the reader (steps never subtracted, all reason rows freed, step regex never matches, step regex matches prose, closing list also filtered): each turns at least one control red, reader restored byte-identical after each.
- `pnpm run typecheck`: exit 0.
- `pnpm test`: 114 of 11,883 failing, all in files unrelated to the reader (see above); 113 of them fail identically with `main`'s reader.

## Anything a reviewer should be sceptical of

- The fix sits in the reader, not in the closing parser, so a body edited after merge is read as before.
- Test (e) pins that `Refs` is read as `Part of`; if the house convention is that `Refs` never frees a row, that line is the one to change.
- The rule is written for authors only in the PR template; no rules file in this repository teaches it.

🤖 Generated with [Claude Code](https://claude.com/claude-code)
