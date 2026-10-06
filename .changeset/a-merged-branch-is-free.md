---
"agent-org": patch
---

A claim is no longer refused by a local branch that holds nothing `origin/main` lacks (a11ign/a11ign#3745). `row-claim claim --branch=<b> --worktree=<p>` asked only whether `refs/heads/<b>` existed, so the first slice's leftover branch of a multi-slice row refused every later claim of the row: #3566 was offered and refused on 93 ticks in 24 hours. It now asks what the branch holds. A tip that is an ancestor of `origin/main`, with no worktree holding the branch, is recreated at `origin/main` (`git worktree add -B`), after the fetch re-checks that the old tip is still an ancestor, and the claim line and result (`replacedTip`) carry the old sha. Every other state is refused as before, and the refusal now says which: "merged into origin/main" or "NOT merged into origin/main, N commit(s) ahead", plus the holding worktree's path; a merge state or worktree list git cannot give counts as NOT free. `claimLineFor` is exported for its test.
