A reopened chairman row whose build merged and whose only item left is a host read is no longer refused by B4 on the files its finished build edited. Closes a11ign/agent-org#732. Replaces a11ign/agent-org#727 (its prototype commit is carried over).

Closes a11ign/agent-org#732

## What changes, and why

- `lookupMyRegionFiles` (the asking side) reads `no-code-left` the way `claimedRegionsOf` (the reservation side) already did, and answers `[]` -- a real, comparable "no files" -- for a labelled row. A failed lookup is still `null`.
- `lookupMyRegionFiles` and `lookupIssueBody` ask the SAME argv, `--json body,labels` (one exported `ROW_READ_FIELDS`), so the claim's batched pre-write read serves both from one `gh issue view`. `lookupIssueBody` keeps its "response carried no body field" throw.
- The three test files whose `issue view` mocks answered by `fields === "body"` answer by whether the requested fields include `body`, so a `body,labels` ask is served and a mock with no `body` still fails loud.
- Changeset (patch).

## How you verified it

Run with `AGENT_ORG_HOST=/home/agent/repos/a11y-witness/.agent-org/host.json`; the Acceptance line is the row's command without its `cd` (that path holds `main`, which carries this only after the merge).

```
$ node --import tsx --test <the row's seven files>
ℹ tests 182   ℹ pass 182   ℹ fail 0
$ node_modules/.bin/tsc --noEmit -p tsconfig.json   # no error in the touched files
```

Positive control (a row naming `src/x.ts` with `no-code-left` asks for no files), negative control (the same row without the label asks for `src/x.ts`; an answer with no `labels` is unlabelled, not failed), failed lookup `null`, the exact label name only, "the row's body and its edge, once each" still two `issue view`s, and the new test that the two lookups' argv are equal.

Acceptance: `node --import tsx --test src/packaging/row-claim-file-overlap-rule.test.ts src/row-claim-reads-together.test.ts src/row-claim.test.ts src/packaging/wake-drain.test.ts src/work-tick-cost.test.ts`

Mutation: 4 mutants, each killed by a named test. The label never read (`#727 positive control` and `#727 ACCEPTANCE, END TO END` red); the label always clearing (`#727 negative control`, `#710` no-Region, `#462`, `#2769` red); the template check's body read asking `body` alone (`#732 ... ONE argv`, `the pre-write reads go out in ONE batch` and `RESUMING a row` red); the label matched by prefix (`#727: the label is an exact name` red). Sources restored with `cp`, `git status` clean.

The Acceptance above is three of the row's seven files (the CI job can run) plus the two outside files: it has no token, and `row-claim-session-eligibility.test.ts` (which needs `token` through `sessionEligibilityReason`) is refused there. The row's whole seven-file command passes locally (182 of 182), and the two files above pass 63 of 63.

## Anything a reviewer should be sceptical of

- **Two more test files outside the Region are edited here, by product-manager's order after the suite went red (a11ign#4437), and declared below.** `src/packaging/wake-drain.test.ts` (`fields === "body"` in `claimGh`, `json === "body"` in `STUB_GH`; five tests, #2324 and #3566 (9b)) and `src/work-tick-cost.test.ts` (the `claimReads` mock and `rowReads`, which counted reads by the exact field string; two tests, #3566) answered `issue view` by the exact string `body`, so the claim's `body,labels` ask fell through to the "A row" labels object. Their mocks now answer by whether the requested fields include `body`; `rowReads` counts a call whose fields are the string or include it as a field, so "the template check's body read and B4's Region lookup are ONE read" still asserts `1`, and the failed-body control still asserts `2`. Nothing else in either file changed. No open pull request touches either file. This supersedes agent-org#737, which was filed for exactly this and is closed.
- **Found by** running the 66 test files that import `claimRow`, the overlap rule or the template rule on the branch before the first push: 1930 of 1950 passed, the 13 others fail the same way on `main` at 51a24d40 (`row-file`, `live-tree-independence`, `row-claim-stale-rule`, `wake`, `work-gate-stale-blocker-cleared`) and are not this change's. The seven this row caused were the only new ones; CI's suite then failed on exactly those seven (`Tests 7 failed | 8842 passed`), and `gate` was red only because `suite` was.

Outside-Region: src/packaging/wake-drain.test.ts — its `issue view` mocks answered by the exact field string `body`; five tests went red once the claim's two row reads share the one `body,labels` argv (agent-org#737, superseded)
Outside-Region: src/work-tick-cost.test.ts — its claim mock and `rowReads` counted by the exact field string `body`; two tests went red for the same reason (agent-org#737, superseded)
