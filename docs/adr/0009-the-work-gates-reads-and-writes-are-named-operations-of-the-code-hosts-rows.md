# The work gate's reads and writes of GitHub are named operations of the code host's `rows`, and the process its executor starts is the plugin's

## Context

ADR 0007 moved the operations `src/ticket-port/` held into `plugins/github/rows/`, and ADR 0008 moved the callers that arm, guard and queue a merge. Step 6 of A11-160 moves the work gate: the 19 files of `src/work-gate/` that held a `gh` argument list, a parse of GitHub's answer, or the spawn of `gh` itself. They differ from the callers of step 5 in three ways.

- **The gate has an executor, and the executor is policy.** `defaultRun` is `gh` made of a bound on a call (30 s), the tick's GraphQL budget, the tick's memo of identical reads, a repository aim (`GH_REPO`) and the census the ledger reads. Every reader the gate has is written over it as `run: (args) => string`, and `readOnlyGh`, `callKey` and the fold of the open-rows lists interpret the argument lists it is handed. That is how the gate runs, not what it asks of GitHub, and it stays core's.
- **The gate reads and writes in the middle of its decisions.** A brief is posted before a label, a label before a body edit; a refused read is `null` for one lane and nobody else's; a row's wait is dated from the newest `unlabeled` event. The decision and its order are core's; the command and the reading of its answer are GitHub's.
- **Some of what it reads is a protocol, not a call.** The required checks are read from the rulesets first and from classic protection when those give nothing, and a refusal becomes part of a report. That is GitHub's own arrangement, and it moved whole.

## Decision

1. **Each question the gate asks of GitHub is a named operation of the code host's `rows` (contract 1.9).** There are 45, named for what the gate asks and not for the command: `labeledEventTimesOf`, `newestLabellerOf`, `commentActivityOf`, `rowTimelineOf`, `waitRefOf`, `incidentItemOf`, `pullsOfBranch`, `newestMergedPulls`, `commitShasOf`, `compareDiffOf`, `failingCheckNamesAt`, `mergeGroupRunsOf`, `readRequiredContexts`, `closedClaimedRowsOf`, `closedRowsCarryingLabels`, and for the writes `commentOnRow`, `addLabelToRow`, `markPullReady`, `addRowToProject` and their kind. Each builds the SAME argument list the gate built, so the memo's keys, the ledger's lines and the census are what they were; each reads GitHub's answer as the gate did and throws, or answers `null` where its name says so, as the gate did.
2. **The gate's `run` is handed to each operation.** The operations take the gate's executor, with its memo, budget and aim, exactly as the operations of ADR 0007 do. A call aimed at another repository (`commentOnRow`'s `aim`, the closed-claim read's) is handed to the executor as its second argument.
3. **The process the executor starts is the plugin's: `gateRun` and `runTogether`.** `ghWithin` is core's policy (the bound it names, the line it tells when a call is cut, the aim it resolves) over `rows.gateRun({ timeoutMs, capture })`, which starts `gh` through `deps.exec` and throws a failure with `code: "ETIMEDOUT"` for a call that hit the bound. `runBatch` keeps the memo, the budget and the chunking, and hands each chunk to `rows.runTogether`, which starts the worker that runs the calls at once. A `gh` whose stderr is not captured lets it through to the process's own, as `execFileSync` did; a call that is cut is killed with SIGKILL, may print 32 MiB (a batch 256 MiB), and throws what `execFileSync` threw: `code: "ETIMEDOUT"`, the signal, and no stderr of its own, so the reader's refusal line still says which signal stopped it. That took two additions to the plugin's `deps.exec`: `ExecOptions.killSignal` and `maxBuffer`, and `ExecResult.signal` and `spawnError` (what stopped the program, and the spawn error that cut it or kept it from starting). The worker's text, which names its script for the ledger (#4148), moved with it.
4. **The rules that read GitHub's own words moved with their reads where they are one thing.** `readRequiredContexts` (rulesets, then classic protection, and the report of why neither gave any) is the plugin's whole. `rowStateAndNewestComment`, `closedClaimedRowsOf` and `labelNamesWithPrefix` keep their paging and their 404-is-absent reading. What the gate DECIDES of the answer (whether a label is a wait, whether a page that came back full is a refused read, who counts as the chairman) stayed in core, and so did the argument-list interpreters of the executor (`readOnlyGh`, `wholeOpenListOf`), which read the lists as data.
5. **The fake's world models what the gate reads beyond rows and pull requests.** `FakeRowsWorld.gate` holds a row's label history (who applied which label, when), the tracker's issue events, merge-group runs and jobs, the diffs and check runs of a commit, the tags that exist and the checks the rulesets require; a comment has an `author`. Core's tests of the moved callers seed it and run on the fake's rows; `gateRun` and `runTogether` have no `gh` to start, so a fake's throw. A test of what an operation SENDS or of the process the executor starts is the plugin's.

## Why

It takes every `gh` argument list, every parse of GitHub's answer and the last spawn of `gh` out of the work gate without moving the gate's decisions into a package that cannot import them (the plugin imports core's types only, ADR 0001), and without changing a single call the live gate makes. The alternative of a generic `gh(args)` in the contract would have left GitHub's command language in the gate, and the ratchet counting its arguments.

## Considered

- **Moving `reads/read-memo-and-exit.ts` into the plugin whole**: rejected. The memo, the budget, the fold and the conditional reads are how the gate runs, and the gate's other files (the tick, the org-health pass, the causes) import its seams.
- **Leaving the spawn in core because the executor is core's**: rejected. The ticket's done-when is that no file outside `plugins/github` calls `gh`, and the spawn was the one call the gate's executor made.
- **Making the gate's operations return the pull requests it lists**: not this step. The open list (`readPrs`) is read through the executor's conditional and memo machinery and parsed there; only the argument list it is asked with is the plugin's (`openPullListArgs`), as `outsideArmListArgs` is for the outside home of arming. Moving the list moves the conditional reads, which is a step of its own.

## Paths

- `agent-org:plugins/github/rows/`
- `agent-org:src/plugins/`
- `agent-org:src/work-gate/`
