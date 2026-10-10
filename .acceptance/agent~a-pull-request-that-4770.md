`closes-mismatch-check` gains a third direction: a pull request whose head ref is an open claimed row's `Claimed-branch:` is refused when it declares `none` for its Closes line, naming the row and saying to declare it and file what remains as its own row (a11ign/a11ign#4770). A branch no row claimed, a fork's branch, and a PR declaring the row pass; an unreadable head, row list or claim record is skipped with its reason and the other two directions still run.

Closes a11ign/a11ign#4770

## What changes, and why

- **`src/closes-mismatch-check.ts`.** `claimedBranchReport` (pure) compares the PR's head ref with `claimRecordOf(row.comments).branch` for each open claimed row; `claimedBranchVerdict` (pure) is what it prints and exits with (only a refusal exits 1, a skip exits 0 so the two existing directions still run after it); `claimedBranchStep` asks only when the declaration is `none`; `lookupOpenClaimedRows` (one GraphQL read: open rows labelled `in-progress`, their newest 100 comments, `null` when the page is not the whole population) and `lookupPrHead` (REST, so it spends `core` and not the GraphQL pool). `main()` calls the step between the declaration check and the closing-reference lookup.
- **Why by ref.** The row's number and the PR's number are unrelated, and a branch is the one thing the claim record names as data. A PR on `agent/an-unrelated-change-4770` holds nothing.
- **Why it lives in this file.** The row's Region is this file and its test only, so the two lookups are here and not in `merge-guard/lookups.ts`, where the other lookups are. They use that file's `gh` and `lookup`, so the leak guard and the null-on-failure rule are the same ones.
- **`src/closes-mismatch-check.test.ts`** (new, 14 tests): the pure cases, the step's wiring with both reads injected (it asks nothing for a Closes line), and the whole CLI against a fake `gh`, the claim records written by the real `claimRecordComment`.

## Platform first, deleting first

platform: GitHub resolves a closing reference from the body but knows nothing of a claim, which is this tool's own record (`Claimed-branch:` in a comment); a branch-protection rule or a label cannot express "this PR is that row's deliverable". Checked: `closingIssuesReferences` (already used by the check's other directions) cannot see a `none`.

Net lines: about +130 non-test in one file. It grows this check because the loophole is exactly the fact that no existing direction can see; nothing was removed or reusable, since the claim record is read by the existing `claimRecordOf` and not re-parsed.

## How you verified it

`AGENT_ORG_HOST` must be set (unset, the files report `0 of 0 tests`, which is not a verdict); I set it to the a11y-witness checkout's `.agent-org/host.json`. The row's own command has no `--config`, and without it rstest finds no suites in this tree, so the config form is the one that ran.

```
$ npx rstest run --config scripts/rstest/rstest.config.ts src/closes-mismatch-check.test.ts src/packaging/closes-mismatch-check.test.ts src/packaging/project-config.test.ts
VERDICT pass: 60 tests in 3 files
$ npx tsc --noEmit -p tsconfig.json     # 2 errors, both the pre-existing mjs-ratchet.test.ts missing-module ones; none in closes-mismatch-check
```

The whole suite: 35 failed of 8175 in 9 files (`board-truth-audit`, `failure-ledger`, `auto-arm-token`, `milestone-clock*`, `mjs-ratchet`, `pr-template-acceptance`, `public-claim`, `project-config`). The same 9 files on a clean detached `origin/main` (`5faefa8`) fail 19 of 160; here they failed 20 of 160, the one extra being `project-config.test.ts`'s repository-name ratchet, which my first draft tripped with a literal in a comment, and removed (it passes above).

The step's output on a fixture (a fake `gh` answering one open row whose claim record names `agent/a-pull-request-that-4770`; PR 4800 on that branch), from `node src/closes-mismatch-check.ts 4800`:

```
$ node src/closes-mismatch-check.ts 4800 a11ign/agent-org    # PR_BODY: a none declaration with a reason
CLOSES MISMATCH: REFUSED -- a claimed row's own pull request cannot keep the row open:
  you declared a `none` Closes line, but this PR's branch agent/a-pull-request-that-4770 is the claimed branch of open row a11ign/a11ign#4770: the PR that IS a row's deliverable closes that row (one deliverable per row).
  declare `Closes a11ign/a11ign#4770`, and file what remains (a live reading, a decision, a later step) as its own row; the merge then closes the row and files the verify row.
exit 1
$ # the same branch, the body declaring the row in full form
CLOSES MISMATCH: ok -- declared and resolved agree
exit 0
$ # the row list cannot be read (the fake gh exits 1 on that query)
CLOSES MISMATCH: skipped the claimed-branch comparison -- could not read the open claimed rows' claim records
CLOSES MISMATCH: REFUSED -- what you declared and what GitHub will actually close disagree: ...
exit 1
```

The last refusal is the existing direction running after the skip, as intended: that fixture's closing-reference answer resolves #4770, which a `none` did not declare. It is not the new direction.

## Anything a reviewer should be sceptical of

- **The CI step is unchanged and a11ign/a11ign's.** It runs `agent-org closes-mismatch-check <n>` for PRs in the tracker only, so this direction fires there. A PR in `a11ign/agent-org` is not run through it by any workflow I found in this repository (`grep closes-mismatch .github` is empty), so whether a layer PR on a claimed branch is caught depends on a11ign/a11ign's workflow passing the repository, which is not this row's Region.
- **Comments read: the newest 100 per row.** A row with more comments and no claim record among them is named in the skip line, which is the verdict when no other row names the branch; a positive match always decides (pinned by a test).
- **Open claimed rows are read as one page of 100.** More than that returns `null` (skipped), never a short list.
- **The row's Acceptance names `src/closes-mismatch-check.test.ts`** as a path under the repository root; the tool also has `src/packaging/closes-mismatch-check.test.ts`, which is unchanged and passes.

Acceptance: `npx rstest run --config scripts/rstest/rstest.config.ts src/closes-mismatch-check.test.ts`

Mutation: the comparison dropped (`holders` never matches) -> 6 red, all in the new file (the refusals and the CLI refusal); compare by the number at the end of the branch instead of by ref -> 2 red (the by-ref case and the released-then-reclaimed case); the comparison always true -> 5 red (the pass cases and the step's control). Each was restored from a copy and diffed byte-identical.
