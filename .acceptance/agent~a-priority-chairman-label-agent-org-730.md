A `priority:chairman` label the chairman did not add now records its own `chairman-label-not-chairman` ledger line, once per row and actor (a11ign/agent-org#730, for a11ign#4885 and #4879, epic #4437). The gate already returned the label as `ignored` and woke `ceo` with "record it as one", but nothing wrote the line, so the incident existed only as a `printf >> failure-ledger` by hand and `class-repeat` never saw the count. **As the row reports it (quoted, not re-measured here):** its Open-check read 2 lines in the ledger, both typed by hand, and its comments at 19:48Z and 19:50Z count 4 hand-typed lines (#4879, #4885, #4877, #4874), all labelled by `a11ign-ai-leads` within 21 minutes.

**What changes.**
- `offerHierarchyNow` (the tick's one call for the hierarchy) hands `readChairmanPriorityOfOffer`'s `ignored` to `recordIgnoredChairmanLabels` (`src/failure-recorders.ts`), which writes `chairman-label-not-chairman` with the ref `<repo>#<row>:<actor>` through `recordFailures`, which reads the ledger first and skips a ref it holds. It is not in `readChairmanPriority` itself because `row-claim.ts` calls that on the claim path, and a reader must not write.
- A history that names no actor is `unknown`, not skipped, and that includes the `null` jq prints for an event whose actor account is gone (`newestLabeller` read the string `"null"` as a login, so it would have been recorded as the actor `null`).
- The order to `ceo` keeps its text and, when the line is in the ledger, says the gate has already recorded it, so `ceo` removes the label and does not type one. Where the ledger could not be written (`recorded` false) it says what it said before, so it never claims a line that is not there.
- The kind is `CHAIRMAN_LABEL_NOT_CHAIRMAN_KIND` in `failure-ledger.ts`, unseeded like `messaging-audience-misuse`: `repeatsIn` and the daily pass read any key.

**Assumption, named.** Done-when 1's "an unreadable history records `unknown`" is read as a history that names no actor (no `labeled` event, or one whose actor is gone), which is what `actor: null` already was. A history READ that THROWS (a refused or rate-limited `gh`) stays `unread`: not honoured this tick, no order, and no ledger line. The row's own sentence on the reader says an outage "cannot be forged", and a line recorded for a refused call would be an incident filed against a label that may be the chairman's.

**Evidence.** The test runs the real tick path (`offerHierarchyNow` over a temporary state directory, then `decide`) and reads the file back with `parseFailureLedger` and `repeatsIn`: a label by `a11ign-ai-leads` over three ticks is exactly ONE line and an order to `ceo` on each tick; the chairman's own label writes no file at all and orders nothing (negative control, with the label read as the chairman's); no `labeled` event and `null` both record `#<row>:unknown` and still order; the same row relabelled by another actor is a second ref, and rows by one actor are a `repeatsIn` repeat of the class (4 refs); a history that throws records nothing and orders nothing; an unwritable ledger does not stop the tick and the order falls back to "record it as one".

Mutation, each file copied aside and restored byte-identical (`diff` empty), the test file only run:
- recorder never writes (`recordFailures` skipped): 4 of 6 red (the one-line test, `unknown`, the relabel/repeat test, and the unwritable-ledger test, which then says "recorded" falsely); the chairman's-own and the throws tests stay green.
- recorder appends every tick without the ledger read: 2 of 6 red, the one-line test and the relabel test (a third went red only because the mutation's own `mkdir` met a file).
- actor-less history skipped instead of `unknown`: 1 of 6 red (`unknown`).
- the chairman's own label recorded too (always fires): 1 of 6 red, the negative control.
- jq `null` read as a login: 1 of 6 red (`unknown`).
- order never says the line is recorded: 1 of 6 red, the first test.
- `recorded` always false: 1 of 6 red, the first test (the order then asks for a line that is there).

`tsc --noEmit` reports only the two `mjs-ratchet.test.ts` errors `origin/main` has. `rstest run --changed=origin/main` ran 318 files, and its 31 failures (9 files: `auto-arm-token`, `milestone-clock*`, `public-claim`, `row-file*`, `tick-heartbeat-is-written`, `wake-engineer-brief`, `work-gate-other-scopes-concurrent`) are the same 31 on a clean `origin/main` worktree in the same environment. The neighbouring `work-gate-offer-hierarchy`, `work-gate-chairman-claimed-holder` and `failure-ledger` tests are green, unchanged.

Acceptance: `AGENT_ORG_HOST=/home/agent/repos/a11y-witness/.agent-org/host.json npx rstest run --config scripts/rstest/rstest.config.ts src/work-gate-chairman-label-ledger.test.ts`

Closes: a11ign/agent-org#730

Outside-Region: src/failure-recorders.ts — the recorder lives beside the other tick recorders, because the gate must not itself write a state file (`org-retro.test.ts` reads a source that names a file and writes as that file's writer; the header of `failure-recorders.ts` says so).
Outside-Region: src/failure-ledger.ts — the kind constant, beside `MESSAGING_AUDIENCE_MISUSE_KIND`, which `failure-recorders.ts` and the test import.
Outside-Region: .acceptance/agent~a-priority-chairman-label-agent-org-730.md — this file.

platform: n/a (no GitHub, pnpm, systemd or git feature; the test takes `gh api .../events` as a seam and writes only in a temporary directory)

🤖 Generated with [Claude Code](https://claude.com/claude-code)
