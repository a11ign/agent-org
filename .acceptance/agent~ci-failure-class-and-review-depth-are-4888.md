`ci-failure-class` and `review-depth` were switched on in `decisions.json` and built, and nothing called either. This is the wiring of both into their real callers, the whole of a11ign/a11ign#4888 except its live reading, which is a separate verify row.

Closes a11ign/a11ign#4888

## What changes, and why

- **Red-PR path.** `wake.ts` reads the facts of a red-check order's first red check over REST (`pulls/N`, `commits/SHA/check-runs`, `actions/runs/ID`, the job log, `main`'s and other PRs' recent runs), asks `ci-failure-class`, writes `wake: <cause> CI failure class: <class> -> <route> (...)` to the journal, and appends the class and the route's words to the prompt only when a provider answered. At most three orders per wake, so a storm of red PRs cannot spend the pool.
- **Reviewer start.** `wake.ts` reads the PR's changed paths and the Regions of the rows it closes, asks `review-depth`, and `spawnReviewer` passes `low`/`high` as the effort override for `light`/`full`. `.github/workflows/`, auth and security paths are `full` by rule, before any provider.
- **Unchanged without an answer.** No provider, an unreadable fact (`null`), or an error leaves the order and the reviewer as they were.

## Platform first, deleting first

platform: n/a (nothing in GitHub, systemd or git classifies why a check failed or sizes a review from what changed).

The wiring is in `wake.ts`, not `work-gate.ts`: the gate is synchronous and a decision is an HTTP call, and `routesForStarts` already resolves async decisions ahead of the sync `deliver`. `src/work-gate/pr-orders.ts` was not touched (outside the Region).

## How you verified it

```
$ bash -c 'cd ~/repos/agent-org && npx rstest run src/ci-failure-class.test.ts src/review-depth.test.ts'   # the row's command, from this worktree
$ node --import tsx --test src/wake-ci-class-review-depth.test.ts
ℹ tests 11   ℹ pass 11   ℹ fail 0
$ (the 21 wake-family test files)
ℹ tests 313  ℹ pass 313  ℹ fail 0
$ node_modules/.bin/tsc --noEmit -p tsconfig.json   # only the pre-existing mjs-ratchet.test.ts missing-module errors
```

Two tests drive the real `wake.ts` entry with stub herdr/gh/git: a red PR reaches `ci-failure-class` (journal line carries the class and route; the checkless control carries none), and a reviewer start reaches `review-depth` (a workflow path is started at `gpt-5.6-luna/high` with "Review depth: full" in the prompt; a docs-only change at `/medium` with no depth line).

Acceptance: `node --import tsx --test src/wake-ci-class-review-depth.test.ts src/ci-failure-class.test.ts src/review-depth.test.ts`

Mutation: 5 mutants, each killed by exactly its own tests (the red-check order never asked; the class never written to the journal; the reviewer never asked; the effort override dropped; the always-full paths not forced). Sources restored with `cp` and proved byte-identical.

## Anything a reviewer should be sceptical of

- **Routes are instruction text to the owner.** Nothing reruns a check or files an incident on its own.
- **`redOnMain` and `redOnOtherPrs` are workflow-level**, not per-test: a red `main` workflow with a different failing test still reads as red.
- **`readsOutsideRepository` is derived from network-error text** in the log.
- **The live reading is its own verify row**, filed with this one.
