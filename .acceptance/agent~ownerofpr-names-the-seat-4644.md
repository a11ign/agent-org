Acceptance: `bash -c 'cd /home/agent/repos/agent-org-wt-4644 && AGENT_ORG_HOST=/home/agent/repos/wt-4644/.agent-org/host.json npx rstest run --config scripts/rstest/rstest.config.ts src/packaging/pr-owner-gone.test.ts src/packaging/pr-owner-total.test.ts'`

Mutation: the rung made never to fire (`if (false) return`) failed 4 of 23; fired without `closingRowsClosed` failed 4 of 23; `pr-owners.ts`'s empty-read guard removed failed 1 of 23 and its `named.length > 0` guard removed failed 3 of 23. Each file restored byte-identical (`diff` against a copy).

Closes a11ign/a11ign#4644

Adds an `owner-gone` rung to `ownerOfPr`, between `dependency-bot` and `ceo`: a pull request whose `session:` label names an ENDED session (`labelEnded`) and whose every named row is closed (absent from a non-empty read of the open rows) is owned by `product-manager` (`DEAD_OWNER_FALLBACK`). It is a real rung, so the ladder says so in its words and `unresolvedOwnerEvents` (keyed on the `ceo` source) does not record it. `pr-owners.ts` puts the fact `closingRowsClosed` on the PR beside `labelEnded`, so `ownerOfPr` stays pure.

**The shape (a11ign#4626):** label `session:worker-4624` (ended), branch `agent/failure-class-owner-unresolved-4624`, row #4624 closed while the PR stayed open. Rungs 2-5 each need a LIVE session holding an OPEN claimed row, so all four failed and it landed on `ceo`, recorded as `owner-unresolved`.

**Controls (`pr-owner-gone.test.ts`):** the same PR with its label alive keeps the label; with its row open and claimed keeps `closing-row`; with its row open but unclaimed still falls to `ceo` and is recorded; with no label still falls to `ceo` and is recorded; an empty rows read (refused) and a PR naming no row are not "every row closed"; a dependency bot's PR still outranks the rung; a live session the branch names outranks it. `pr-owner-total.test.ts`'s grid gains an `ended` label and a `closed` row (3x4x5x3 = 180 cells) with the oracle written out; "never product-manager" became "product-manager only for a dead owner's PR with every row closed".

**Edge, named:** `rowsNamedBy` reads a branch's trailing number as a row (existing convention), so a dead owner's PR on `agent/worker-99` with no `Closes` is `owner-gone` when #99 is not open. The grid pins it (`sessionRetired`).

Mutation: the rung never fires (4 of 23 fail), fires without `closingRowsClosed` (4 of 23), the empty-read guard removed (1 of 23), the `named.length > 0` guard removed (3 of 23); the shared-file wording flag forced false fails its one new test. Each file restored byte-identical (`diff` against a copy). Dropping `labelEnded` from the rung survived as an equivalent mutant (`closingRowsClosed` is only ever set on a `labelEnded` PR), so the redundant condition was removed rather than kept.

Measured: `VERDICT pass: 35 tests in 3 files` (the two Acceptance files plus `work-gate-shared-file-orders.test.ts`); the 28 test files that call `ownerOfPr`, `withPrOwners`, `decide(` or the recorders pass (`VERDICT pass` x4, 874 tests in batches of seven). NOT run: the full suite.

Outside-Region: src/work-gate/shared-file-orders.ts — `ownerSentence` told product-manager "its session label, or the row it closes, names you" for an owner-gone PR (the wording #542's review caught for the bot rung)
Outside-Region: src/work-gate-shared-file-orders.test.ts — the regression test for that wording

platform: n/a (a rung in the owner ladder; the ended-session and open-row reads are the gate's own)

🤖 Generated with [Claude Code](https://claude.com/claude-code)
