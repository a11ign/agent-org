Row agent-org#1671: ownerless pull requests. The `ceo` and `owner-gone` sources, approved-unqueued and green ejection reach orchestrator (split from a11ign/agent-org#1648).

Done-when 1, the change, as built. Behind `prs.ownerlessAsk` (OFF when absent, already registered by #1648), a pull request with no live `session:` label whose owner source is `chairman-author`, `ceo` or `owner-gone` is ordered to `orchestrator` when it is red, ejected or hung; when it is approved and out of the merge queue past `UNQUEUED_MINUTES` (15); or when the queue ejected it green and it stays the owner's. Each order names the pull request, its owner source and the minutes. A pull request under `ceo` or `owner-gone` that is OUTSIDE the org is never asked. A live label yields nothing extra, and with the flag OFF every order is as it was. The approved case also gets one per-pull-request order (`pr-green-unarmed`, subject `pr-<repo>#<n>`) to orchestrator; the existing product-manager aggregate for that cause is unchanged, so the same pull request can appear in both.

Acceptance:

```bash
node_modules/.bin/rstest run --config scripts/rstest/rstest.config.ts src/packaging/ownerless-pr-order.test.ts
```

The file runs from the worktree. It has 16 tests, each with a control: the positive cases for each source and cause, the routing-off and flag-off controls, the live-label control, the OUTSIDE negative, the dependency-bot control, and the clock tests at the boundaries (14 and 15 minutes for the signal, 14 minutes 30 seconds and 15 minutes 1 second for the approved path). Result: 16 passed, 0 failed.

Mutation, each run by hand on the file it names, and each file restored byte-identical (`cmp` against a copy in the scratchpad): (a) withholding the ownerless red build instead of asking it turns 4 tests red, including the POSITIVE; (b) admitting the `label` source (a labelled pull request asked) turns 2 red, including the label control; (c) the signal counting at 14 minutes (`src/org-health.ts`) turns the CLOCK test red (1 of 15); (c2) the approved clock counting at 14 minutes (`src/work-gate/pr-orders.ts`) turns the new approved-boundary test red (1 of 16).

Checks: `pnpm run typecheck` (`tsc --noEmit -p tsconfig.json`) reports no errors. `pnpm test` has 75 failing tests, all of which also fail at HEAD (the baseline was run from a `git archive` export of HEAD with the same host state): the name diff shows no new failure. Three files (`src/packaging/work-gate.test.ts`, `src/pr-owner-routing.test.ts`, `src/work-gate-cross-repo-pr-owner.test.ts`) pass 414 tests on their own. Those files now pass `ownerlessAsk: false` (or, for the cross-repo tests, pass it through `scopeTick`'s new optional last argument) because the host state has `prs.ownerlessAsk` ON, and before this they depended on it.

Assumptions: `pr-ejected.ts` posts a PR comment for a stranded ejection and emits no order, so a green ejection gets exactly one order (the per-pull-request one from `decide`). The host flag `prs.ownerlessAsk` is already ON in `~/.cache/a11ign/machinery-canary.json`: once this is deployed the ask is live on this host. Switching the flag on belongs to a11ign/a11ign#5667, not this row.
