The claim record now remembers a hash of the row's `## Region` and `## Acceptance` as they stood when the row was claimed, so a later row can tell scope added UNDER a holder from scope the row always carried. This row only remembers: it writes `Claimed-scope: <hash>` and reads it back, and the comparison is a11ign/a11ign#4759.

Closes a11ign/a11ign#4739

## What changes, and why

- **`scopeHash(body)` (`src/row-claim.ts`, exported).** A 12-character SHA-256 prefix over the Region and Acceptance sections as `extractLabeledSection` reads them (the reader `templateFieldsReason` already runs over the same body, so the hash and the claim cannot disagree about what the Region is), each whitespace-normalised. An ABSENT section hashes as `null`, not as the empty string, so a row that gains one reads as changed. It reports a change and not its direction: a narrowing hashes differently from the original exactly as a widening does, and what to do about each is the sibling row's decision.
- **The record.** `claimRecordComment` writes `Claimed-scope:` for a claim that passes a `scope`, never for a release. `claimRecordFrom` returns `scope` (`null` for no record, a release and every record written before this row). The scope line is kept out of the "is a git object recorded" test, so a scope-only comment still says `No branch or worktree is recorded`.
- **The claim path.** `preWriteChecks` already reads the row's body for the template-fields check; it now returns `scopeHash` of THAT body, and `completeClaim` hands it to `postClaimRecord`. No new `gh` call, and the hash is of the row as it was checked, not as a second read finds it. A keyed tracker's row hashes the tracker's body (`lookupIssueBody` takes its `repo`). A body that could not be read writes no line: `null` is "could not read", and a hash of an empty body would say "the scope was empty".

## Platform first, deleting first

platform: n/a (the claim record is this tool's own comment; GitHub keeps no per-claim snapshot of a section of an issue body, and an issue's edit history is not readable by the gate's tick for free).

Net lines: positive, mostly tests; the production change is one pure function, one record line and one value threaded through two functions.

**For #4759, which compares it:** `scopeHash` is exported from `row-claim.ts`, which `claim-labels.ts`'s header says a tick cannot import (the heavy rule-set graph). The producer will need it in a leaf, as `CLAIM_RECORD_MARKER` was moved (#2110). This row's Region is the two `row-claim` files only, so it is left for that row to move.

## How you verified it

`row-claim.test.ts` imports `row-claim.ts`, which resolves the host checkout at import, so the command needs `AGENT_ORG_HOST` set (the same finding as #4740's PR); unset, the file fails to load and reports `0 of 0 tests`, which is not a verdict on the diff. I ran with it set to a11ign's `.agent-org/host.json`.

```
$ AGENT_ORG_HOST=<a11y-witness>/.agent-org/host.json npx rstest run --config scripts/rstest/rstest.config.* src/row-claim.test.ts
VERDICT pass: 33 tests in 1 file          # 24 existing, 9 new
$ AGENT_ORG_HOST=<a11y-witness>/.agent-org/host.json npx rstest run --config scripts/rstest/rstest.config.ts     # the whole suite
VERDICT fail: 34 of 8059 tests failed in 440 files
$ <the same 12 files, a detached origin/main e79b55c>
VERDICT fail: 34 of 362 tests failed in 12 files
$ npx tsc --noEmit -p .     # only the pre-existing mjs-ratchet.test.ts missing-module errors
```

The 34 are `board-truth-audit`, `failure-ledger`, `auto-arm-token`, `milestone-clock*`, `mjs-ratchet`, `pr-template-acceptance`, `public-claim`, `row-file*`, `tick-heartbeat-is-written` and `wake-engineer-brief`: the same 12 files fail the same 34 tests on `origin/main` without this diff, measured, so none is this diff's (they read the host checkout and this worktree is not one). No file of the 12 touches the claim record. Not rerun: CI's tree-wide guards.

Acceptance: `npx rstest run --config scripts/rstest/rstest.config.* src/row-claim.test.ts`

Mutation: the hash ignoring Acceptance -> 2 red (the changed-Acceptance test and the absent-vs-empty test); the hash reading the whole body -> 2 red (prose-outside-the-sections and the claim's read-back); whitespace not normalised -> 1 red (the positive control); the claim path passing no scope -> 2 red (the first-tracker and keyed claims); the reader never finding the line -> 3 red; a release also carrying the line -> 1 red; an unreadable body hashed as empty -> 1 red. Each broke its own tests and no other, and every mutation was restored by copying the original back and diffing (byte-identical).

## Anything a reviewer should be sceptical of

- **The hash is 12 hex characters (48 bits).** It detects an edit by an honest author, not a deliberate collision; a collision here would read as "scope unchanged", which is the quiet direction, so the length is a judgement, not a measurement.
- **`extractLabeledSection` takes the FIRST matching heading or inline `Region:` line.** A row with an earlier inline `Region:` line in prose hashes that line. It is the reader the template check already uses, so the claim and the hash agree, but a row that quotes its own template early would hash the quote.
- **Records written before this row read `scope: null`**, so the sibling row has nothing to compare for any row claimed before this merges; that is its decision to make, and this row does not backfill.
