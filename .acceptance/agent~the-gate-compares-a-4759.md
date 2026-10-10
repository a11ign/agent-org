The gate now compares each claimed row's live `## Region` and `## Acceptance` with the hash its claim record holds (`Claimed-scope:`, a11ign#4739) and orders `product-manager` to file the amendment as its own row and return the claimed row's text to what was claimed. Second of the three rows split from a11ign/a11ign#4627 (class `row-not-finishable`; chairman direction, #4627 comment 6095044053: scope added after the claim is a NEW row).

Closes a11ign/a11ign#4759

## What changes, and why

- **The leaf, `src/claim-scope.ts` (new).** `scopeHash`, `SCOPE_SECTIONS`, `SCOPE_HASH_LENGTH`, `CLAIM_RECORD_SCOPE` MOVE here from `row-claim.ts`, with a pure reader `claimedScopeOf(comments)` of the newest claim record's `Claimed-scope:` line, by `CLAIM_RECORD_MARKER`. A tick cannot import `row-claim.ts` (`claim-labels.ts`'s header; worker-4739's finding on the row). `row-claim.ts` imports from the leaf and re-exports `scopeHash`, so its call sites and `row-claim.test.ts` are unchanged; `claimRecordFrom` reads `scope` through `claimedScopeOf`, so the line has ONE reader, not two.
- **The producer, `src/work-gate/scope-added-orders.ts` (new).** `claimedScopesOf` pairs each `in-progress` row's recorded scope with `scopeHash` of its live body; `scopeAddedReadings` keeps the ones where a recorded scope differs; `scopeAddedOrders` makes ONE order per (row, live hash) to `product-manager`, a digest line. The key names the live hash, so an unchanged amended row is byte-identical every tick and the waker's ledger drops it; a row amended again is a second question. Nothing is flagged for: a never-claimed row, a claim with no recorded scope (every claim before #4739), an unchanged row, prose outside the two sections, a comments page that was refused or did not carry the row, a body that was not read, or another tracker's row.
- **The call line, `src/work-gate/org-health.ts`.** One import and one spread in `orgHealthNow`'s return, as the row's Region note says.
- **One table line, `src/work-gate/org-health-suppression.ts`** (declared below as `Outside-Region`): `org-health-suppression.test.ts` refuses any `org-health/<class>` literal the table does not declare, so `scope-added-mid-row` is declared `digest`. It only affects orders to `ceo`; this one goes to `product-manager`.

## Platform first, deleting first

platform: n/a (GitHub keeps an issue's edit history, which is why the order points at it, but a tick cannot read it for free: one GraphQL `userContentEdits` call per claimed row, against the hash the claim record already holds at no call at all).

Net lines: positive, mostly the new test; the move out of `row-claim.ts` is a net deletion there (-19 lines).

## How you verified it

```
$ npx rstest run --config scripts/rstest/rstest.config.* src/work-gate/scope-added-orders.test.ts     # no AGENT_ORG_HOST in the environment
VERDICT pass: 10 tests in 1 file
$ AGENT_ORG_HOST=<a11y-witness>/.agent-org/host.json npx rstest run ... src/row-claim.test.ts src/work-gate/org-health-suppression.test.ts src/work-gate/org-health.test.ts
VERDICT pass: 50 tests in 3 files
$ npx tsc --noEmit -p .          # nothing but the pre-existing mjs-ratchet.test.ts missing-module errors
$ AGENT_ORG_HOST=... npx rstest run --config scripts/rstest/rstest.config.ts       # the whole suite, this branch
VERDICT fail: 34 of 8233 tests failed in 451 files
$ the same 12 failing files, this branch and a detached origin/main 6c56776
VERDICT fail: 34 of 362 tests failed in 12 files   (both, measured)
```

The 34 are `board-truth-audit`, `failure-ledger`, `auto-arm-token`, `milestone-clock*`, `mjs-ratchet`, `pr-template-acceptance`, `public-claim`, `row-file*`, `tick-heartbeat-is-written` and `wake-engineer-brief`: the same 12 files and the same count fail on `origin/main` without this diff (they read the host checkout and a worktree is not one), so none is this diff's. Not rerun: CI's tree-wide guards.

**Against the real tracker (read-only; the gate's own `readOpenRows` and `readClaimedRowComments`, then `orgHealthNow` with every other read stood in), 2026-10-10 about 09:12Z:**

- #4759 as it stands: its record's `Claimed-scope: 53eeb5291a82` equals `scopeHash` of its live body, so it is not flagged (the leaf's hash agrees with the one the claim wrote, measured).
- #4759 with one path added to its Region IN MEMORY: one order, `product-manager/org-health/scope-added-mid-row@4759:2be87ff0df75`.
- **A real one, unplanted: #4789** (held by `worker-4789`). Its claim record, 09:01:53Z, holds `Claimed-scope: e43681aa67ab`; its body was edited at 09:04:23Z (GitHub's `userContentEdits`) and its own comment at 09:04:24Z says `Region re-scoped ... Added agent-org:src/work-gate/claim-stall-tick.ts`. The live hash is `fa1be331762e`, so it is ordered:

  `{"session":"product-manager","cause":"org-health","subject":"scope-added-mid-row-4789","discriminator":"4789:fa1be331762e","prompt":"SCOPE ADDED UNDER A HOLDER. #4789, held by `worker-4789`, has a Region or Acceptance that no longer reads as it did when it was claimed (`Claimed-scope: e43681aa67ab`, now `fa1be331762e`). An amendment to a claimed row is a NEW row: FILE the added scope as its own row (a new number, `blocked-by` #4789 if it needs that row's files) and RETURN #4789's Region and Acceptance to what was claimed -- its edit history holds the text.","causeKey":"product-manager/org-health/scope-added-mid-row@4789:fa1be331762e"}`

Acceptance: `npx rstest run --config scripts/rstest/rstest.config.* src/work-gate/scope-added-orders.test.ts`

Mutation: the comparison never firing -> 6 red (the positive control, the Acceptance case, both controls inside the prose and pre-line tests, the ordered-once test and the wiring test); firing on any recorded scope -> 4 red (the unchanged and prose-only rows, the newest-record test, the refused-read test, the wiring test); a null scope counted as a change -> 3 red (the never-claimed, pre-line and newest-record tests); the dedupe removed -> 1 red (ordered once); the oldest record read instead of the newest -> 2 red (one here, one in `row-claim.test.ts`); the hash covering the whole body -> 5 red (three in `row-claim.test.ts`, the prose-only and ordered-once tests here); the call line removed from `org-health.ts` -> 1 red (the wiring test, and only it); the class left out of the suppression table -> 2 red (`org-health-suppression.test.ts` and the class pin here). Each broke its own tests and no others, and every mutation was restored by copying the original back and diffing (byte-identical). The first attempt at the whole-body mutation did not read the body and stayed green: it was a bad mutation, not a gap, and was redone.

## Anything a reviewer should be sceptical of

- **Done-when 2 is NOT met as written, and the pull request says so.** It asks for the reading shown once from the gate on a SCRATCH row amended after its claim. I did not make one: a spawned engineer claims no second row (#2407), and a claim record and `in-progress` written by hand on a scratch row would send the real claim-stall tick after a worktree that does not exist. What is shown instead is above: the gate's real readers over the real tracker, including a real amended claimed row (#4789). The first tick after this merges is the live proof, and Done-when 2 is `product-manager`'s to accept or restate.
- **`product-manager` will be ordered about #4789 on the first tick after merge**, and that is the rule working: its holder re-scoped its own Region under the row's "a file outside the list is needed" clause. The chairman's direction is that scope added after the claim is a new row, and the order says so; whether a holder's own re-scope under such a clause is the same case is a ruling, not this diff's.
- **The hash says a change and not its direction**, so a NARROWING is ordered as an amendment too, and the order says "a Region or Acceptance that no longer reads as it did". That is the same limit `scopeHash` states.
- **A claim made before #4739 merged reads `null` and is never flagged**, and a RE-claim compares with the newest record, so a hand re-claim at the wider scope silences the order. That is the intended way to accept an amendment; it is also a way to silence it.
- **The leaf is not import-free**: `claim-scope.ts` reaches `region-paths.ts`, which resolves the host checkout at import. The row names exactly those two imports, and `org-health.ts` already has them; the test sets the fixture host before importing so the Acceptance command needs no `AGENT_ORG_HOST`.
