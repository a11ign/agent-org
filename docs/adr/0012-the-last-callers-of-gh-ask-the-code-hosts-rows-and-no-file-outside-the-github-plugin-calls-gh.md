# The last callers of `gh` ask the code host's `rows`, the shell scripts that ran `gh` move into the plugin, and no file outside `plugins/github` calls `gh`

## Context

ADRs 0007 to 0011 moved the ticket port's operations, the callers that arm, guard and queue a merge, the work gate, wake, the claim and the filing of rows, and the board, the health and retro readings, the trace and the chairman's watch. Step 9 of A11-160 moves what was left of `docs/gh-call-baseline.json`: 50 files. They are of four kinds.

- **Callers that read or write rows and pull requests** (the label audit, the closing of rows for a merged pull request, the CI failure class and the ledgers, the queue and trunk readings, the read-only reporters, `pr-open` and `pr-hold`, the branch tools): the same shape as steps 4 to 8.
- **Callers that only start the program**: `gh-ledger.ts` (the retry of a queued call), `survey.ts` (a worker's read-only `gh` argument list), `lib/tool-version-agreement.ts` (`ghWith`, the spawn ticket mode's helpers read GitHub through), `scripts/review-eval.ts`.
- **A rate-limit probe** (`api-pool.ts`) that the work gate's pacing and the org-health host read.
- **Three shell scripts of `host/`** (`board-report-dispatch.sh`, `manager-spend-post.sh`, `trace-weekly-post.sh`) that a systemd unit starts and that run `gh` as a command word.

## Decision

1. **Seven more sections of the code host's `rows` (contract 1.12)**, one file each in the contract, the plugin, the fake and the suite: `pullwork`, `audit`, `closing`, `classes`, `queue`, `readouts` and `plumbing`. `CodeHostRows` extends their interfaces; the plugin's `createRows` spreads their operations; the fake's world carries `tail.<section>`; the contract suite gathers their operations and checks from `conformance/rows-tail.ts`. Every operation is named for what core asks and builds the argument list its caller built, in the same order; none is a pass-through.
2. **A caller that starts the program keeps its policy and asks the code host for a runner with it** (`runnerWith`, step 8), now with `env` (an overlay on the process's environment) and `inherit` (the child's terminal, for `pr-open`'s create). `ghWith(env)` is `rows().runnerWith({ env, timeoutMs: 30 s, ... })`: the 30 s cut, the buffer and the overlay are the ones it had.
3. **The three shell scripts moved into the plugin, byte for byte**, to `plugins/github/host/`. A shell script that runs `gh` is the plugin's, as the routing wrapper is. The units still start them from the tool checkout; `host/*.service.in` changes only the script's path, and the host install lists the plugin's `host/` among the places it ships scripts from. The `.service.in` and `.timer.in` files stay in `host/`.
4. **The GraphQL pool's probe is the code host's** (`graphqlPoolProbeArgs`), so `api-pool.ts` stays a leaf that takes the probe it is given.
5. **The ratchet is final.** `docs/gh-call-baseline.json`'s `files` is empty, and `gh-call-ratchet.test.ts` refuses any file outside `plugins/github/` that spawns `gh` or holds a `gh` call shape, by name, with no entry to raise. The guards that were written over "a file that spawns `gh`" were re-aimed at the code host: a unit that reaches a file asking the code host for its rows is a unit that spends the account's rate limit (`ghSpawnReachedFrom`, `host-units.test.ts`); `live-default-seams.test.ts` holds that the tree has no live default seam; `no-search-reads.test.ts` accepts "asks the code host's rows" as reading through the connection readers.
6. **The tests of the moved callers use the fake**, and the cases whose subject is the argument list or GitHub's answer are the plugin's tests. A case that tests core's executor (the gate's memo, bound and census) keeps a `run` that records argument lists and answers no GitHub shape.

## Why

It finishes Decision 2 of A11-157 (core depends only on the contracts) for the GitHub plugin without changing a command the live org sends: each operation is the caller's argument list moved, and each runner keeps the working directory, bound, buffer, environment and stderr handling the caller had. Where a call had no bound, the runner's ten minutes apply, as in step 8.

## Considered

- **A generic `gh(args)` in the contract for `survey.ts`** (its argument list is a worker's): rejected, as in ADR 0011. The survey asks the code host for a runner with its working directory and buffer; the argument list stays the worker's, as it was.
- **Leaving the shell scripts in `host/` and calling a core command from them**: rejected. The command would be a pass-through, and the scripts would still be the place GitHub's command language lives.
- **Keeping `src/ticket-port/`'s exemption until the last file moved**: it was already gone in step 4.

## Paths

- `agent-org:plugins/github/`
- `agent-org:src/plugins/`
- `agent-org:src/`
- `agent-org:scripts/`
- `agent-org:host/`
- `agent-org:docs/gh-call-baseline.json`
