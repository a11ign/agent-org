A detector files a ledger incident when an announcement asks the chairman something, or an ask has no row or record. `auditMessaging` reads the messaging ledger past a cursor and appends one `messaging-audience-misuse` entry per message and failed half, naming the ref and the half and quoting at most 80 characters; it prints `messaging audit: n checked, m flagged`. This is a11ign/a11ign#4746, row 4 of 5 of #928.

Closes a11ign/a11ign#4746

## What changes, and why

- **`messaging/audit.ts` (new):** `misuseOf` (one line to the halves it fails), `auditLines`, `eventOf` (the ledger entry) and `auditMessaging` (the pass: cursor, record, count line). Only a delivered outbound message is checked: a failed, digested or `edited` line told the chairman nothing, and the digest and the open-asks list are not asks.
- **`failure-ledger.ts`:** the class key `MESSAGING_AUDIENCE_MISUSE_KIND`, beside `UNIDENTIFIED_CALLER_KIND`, not in `FAILURE_KINDS`, whose test pins the six first-move kinds.
- The request markers are the project's own labels, read from `project-vocabulary.ts` (`NEEDS_CHAIRMAN_LABEL`, `ANSWER_PREFIX`) and not spelled in the file, which `project-vocabulary.test.ts` caught.

## Judgement calls

- **The first run baselines at the end of the ledger** instead of auditing from the start. An ask sent before #4745 has no `askId` or `row`, so it is not a misuse, and a flood of them would read as a repeat in the daily pass.
- **The cursor is a line count beside the ledger** and moves only after the entries are written; `recordFailures` skips a (class, ref) already logged, so a refused append retries without a duplicate.
- **An `edited` tick is skipped:** a stall's tick carries `row: null` and no `rowLess`, so checking it flags every stall. The real-core test ticks a stall in place to hold this.
- **The "reply" marker is the word, case-insensitively,** as the row names it; a text that mentions the word otherwise is a false positive the ledger entry makes visible.

## Known limits

- **The once-per-tick call is not wired.** The call belongs in `failure-recorders.ts` (or `work-gate.ts`), outside this row's Region; it is filed as its own row. Until then `auditMessaging` is exported and tested, not run by the tick.
- The ledger's line order is its identity, so a ledger that is rotated or truncated is read from the start (reported).

## How you verified it

Run with `AGENT_ORG_HOST` set. Measured at this head:

- The Acceptance: 21 tests, all pass.
- The whole suite fails the same 35 tests as the clean checkout (counts compared: 35 of 8309 there, 35 of 8330 here); `project-vocabulary.test.ts` and `failure-ledger.test.ts` do not fail for this change (`failure-ledger.test.ts` has one failure the clean checkout has too).
- `tsc --noEmit`: no error in `audit.ts`, `audit.test.ts` or `failure-ledger.ts`; the two `mjs-ratchet.test.ts` errors are `origin/main`'s.

Acceptance: `bash -c 'cd /home/agent/repos/agent-org-wt-4746 && AGENT_ORG_HOST=/home/agent/repos/wt-4746/.agent-org/host.json npx rstest run --config scripts/rstest/rstest.config.ts src/messaging/audit.test.ts'`

Mutation: `misuseOf` stubbed to return none -> 11 red; the question half flagged for every announcement -> 2 red; the row and record halves flagged for every ask -> 6 red; the `edited` skip removed -> 2 red; the cursor ignored -> 1 red. Each restored byte-identical (`diff` against a copy taken before) and green.
