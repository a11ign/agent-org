# Arming, the merge guard and the merge queue's dispatcher are named operations of the code host's `rows`

## Context

ADR 0007 moved the operations `src/ticket-port/` held into `plugins/github/rows/` and left their callers in core, each handing its own `run`. Step 5 of A11-160 moves five of those callers: `arm-pr`, `auto-arm-sweep`, `merge-guard` (with `merge-guard/*`), `merge-queue` and `pr-armed-state`. They differ from the ticket port's files in three ways.

- **They are programs, and libraries.** `arm-pr` and the sweep are commands the project's workflows run, and also functions the gate's arming port, the outside home of arming and the wake path import. Their decisions (the hold, the authorship, the open blockers, the labels, the exit codes, the guard's rules) are core's and are tested as such; what they ask of GitHub is a handful of questions each.
- **Their calls are interleaved with those decisions.** `arm-pr`'s `armMerge` is "arm, and if it is refused, ask whether the pull request settled or was armed meanwhile, and only then believe the refusal". A move that took the file whole would have to take the hold predicate, the lanes, the `Closes` parser and the decision switches with it, and the plugin imports core's types only.
- **Some of what they call has not moved.** `authorshipVerdict`, `crossRepoRedVerdict` and `deliberateRefusalVerdict` take a `run`, and so do the importers of `merge-guard/lookups.ts`'s `gh` (row claims, the sweeps, the nightly): they move in later steps.

## Decision

1. **Each question these callers ask of GitHub is a named operation of the code host's `rows` (contract 1.8)**, named for what core asks and not for the command: `readPullForArming`, `openBlockersOfRow`, `armPullAuto`, `armedReasonOf`, `readQueueSeat`, `jumpToFront`, `readSweepFacts`, `requiredContextsOf`, `checkRunsOfCommit`, `pullForGuard`, `openPullsForQueue`, `mergeQueuedPull`, and the rest. The rules that read GitHub's own words (`armedFromApi`, `armedReason`, `queueEjectionOf`, `openBlockersOf`, `settledReason`) are operations too, so one definition of "armed" is still asked. The decisions stay in core, calling the operations.
2. **`run` is optional on them, and on the 1.7 operations these callers use.** A caller that has not moved (the gate, the outside home, the sweep's importers) hands its own, with its identity and call census; a caller that has moved hands none, and the plugin runs `gh` itself (`deps.exec`, thirty seconds a call). The merge queue's dispatcher is started from a worktree, so its operations run with the git variables a hook sets taken off (`ExecOptions.withoutEnv`), as `sandboxGitEnv()` did.
3. **The arm is a procedure of the plugin: `armMergeOf`.** `CodeHost.armMerge` (the port's, unimplemented until now) is that procedure and a read-back of the pull request, and core's `armMerge` delegates to it, so the settle poll is written once.
4. **`ownRun`, the plugin's own `gh`, is a member of `rows` for the callers that still need a runner and hold none.** It is a pass-through, which the plan refuses for the contract, so it is marked transitional in the contract, in the plugin's README and here: it exists because `lookups.gh` is imported by files that move in steps 6 to 9 (the row claims, the sweep window, the nightly, the workflow-run liveness check), and goes with the last of them. A fake's `ownRun` throws, so a core test of a moved caller cannot reach it.
5. **Core's tests of the moved callers run on the fake's `rows`.** The fake's world gained what arming and the guard read: a pull request's author, head, base, check runs, review decision, ejection, closing rows and how far behind `main` it is, the trunk's runs, and `failures`, a map from an operation's name to the error it throws when called, so a test refuses a read by name. A test that is about an operation itself (the arguments it sends, how it reads GitHub's answer) is the plugin's and moved to `plugins/github/rows/`.

## Why

It takes every `gh` argument list and every parse of GitHub's answer out of five core files without moving core's decisions into a package that cannot import them, and it leaves the importers that have not moved working. The alternative of a generic `gh(args)` in the contract would have left GitHub's command language in core and the ratchet counting its arguments.

## Considered

- **Moving `arm-pr` and the sweep into the plugin whole**: rejected. They import the hold predicate, the lanes, the decision switches and the `Closes` parser, which are core's, and the plugin imports core's types only (ADR 0001).
- **Making every caller's `run` mandatory until its last user moves**: rejected for the moved callers. A moved caller handing the gate's `run` back to the plugin would keep the spawn in core.
- **Dropping `ownRun` by changing the importers of `lookups.gh` now**: not this step. They are row claims, sweeps and the nightly, which are steps 7 to 9, and changing them here would make this pull request the whole ticket.

## Paths

- `agent-org:plugins/github/rows/`
- `agent-org:src/plugins/`
- `agent-org:src/arm-pr.ts`
- `agent-org:src/auto-arm-sweep.ts`
- `agent-org:src/merge-guard.ts`
- `agent-org:src/merge-queue.ts`
