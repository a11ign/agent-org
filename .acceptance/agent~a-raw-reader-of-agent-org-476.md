A reader that sums the trace store's lines without de-duplicating by id is refused by a test, the store's duplicate ids are counted on every ingest, and `trace cost` is the one command that sums (agent-org#476; chairman direction on a11ign/a11ign#4437, class `metrics-integrity`: "every reader de-duplicates by id until then", "a detector counts duplicate ids daily and alerts on any above zero").

**What changes.**
- `duplicateIds(path)` (`store.ts`): the ids on more than one line and the extra lines they hold, read in chunks with each line's id taken off its first bytes (a line of another shape is parsed), never parsing a line into an event. `trace.ts duplicates [--store <path>]` prints the count and exits 1 above zero.
- `trace.ts cost --by day|row|cause|session [--since <ISO>] [--store <path>]`: sums turns through `readStore` and `repriceEvents`, the first line saying so; prices come from `PRICES`, never from the stored `costUsd`; a second column reprices every cache-read token at $0.20/M, the rate Claude Code's own cost display reads at. An unpriced model is counted in its own column, not dollared.
- `DEFINITIONS` says a stored `costUsd` is a first reading (cache-read pricing moved from $0.20 to $0.10 on 2026-10-08), so a sum of it over the raw file is wrong for that reason as well as for the duplicates.
- `src/packaging/trace-store-readers.test.ts`: no module under `src/` reads the store file's lines itself. It names its exceptions with reasons (`loadSeenIds`, and `newestTurnAt` in `freshness.ts`, see below) and fails on an exception that no longer reads.
- `trace -- --ingest` prints `duplicate ids: n (m extra lines)` and exits 1 above zero.

**Which path the alert takes (Change 2), said as asked.** The ingest's other failures reach the world through its EXIT CODE: `freshness.ts` runs `--ingest` and exits with its status, so the `a11ign-trace-ingest.service` unit shows FAILED. A count above zero now takes that path and no other; nothing is added. Measured by `git grep -n "trace-ingest"` and `git grep -n "OnFailure="` over `src` and `host`: no reader of that unit's FAILED state sends a person anything (`incident:gate-crash` reads the work-tick unit, and the freshness incident fires on a store with no turn, which a duplicate id does not cause). So a duplicate count is seen in `systemctl --user status a11ign-trace-ingest` and its journal, and not pushed to a person; that is the gap the row said to report rather than fill.

**One more exception than the row named.** `freshness.ts` `newestTurnAt` reads the tail of the file for the newest turn's `at`. It is a maximum, so a duplicate id and a stale `costUsd` change nothing, and reading the whole file every five minutes is what it was written not to do. It is named in the test with that reason.

**Assumption.** The second column prices the cache-read tokens of EVERY model at $0.20, as the row words it, so the columns differ by cache-read tokens x $0.10 per million for a Sonnet 5.5 turn (whose rate in `PRICES` is $0.10), and by the gap between $0.20 and the model's own rate for another. The footer of the output says so.

Acceptance: `cd /home/agent/repos/wt-agent-org-476 && AGENT_ORG_HOST=/home/agent/repos/a11y-witness/.agent-org/host.json npx rstest run --config scripts/rstest/rstest.config.ts src/packaging/trace-store-readers.test.ts`

Mutation: seven hand mutations, each red in its own tests, each restore from a copy in the scratchpad and `diff`ed byte-identical: `duplicateIds` never finding one (2 red); always finding one (3, the negative control among them); the scan never firing (3); the scan always firing (3); `cost` summing the stored `costUsd` (1, `costBy`'s unit case; through the CLI `repriceEvents` has already replaced the stored value, so that mutation is equivalent there); `cost` reading the file's lines raw (3, the source scan among them); the second column at the primary rate (1).

Measured: `trace-store-readers.test.ts` passes 11 of 11; `src/trace` and `trace-store-compact.test.ts` with it pass, 402 tests in 22 files. `tsc --noEmit` reports only the two `mjs-ratchet.test.ts` errors `main` has. The one existing test that pinned `--ingest` to one report line (`freshness.test.ts`) now pins two, and gains the case that a duplicate exits 1.

Closes a11ign/agent-org#476

platform: n/a (the file's lines are counted with a chunked read; no GitHub, pnpm, systemd or git feature counts duplicate ids in an ndjson file)
