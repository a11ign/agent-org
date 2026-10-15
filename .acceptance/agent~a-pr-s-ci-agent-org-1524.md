A PR's CI run that checked out a SUPERSEDED merge commit (one with no parents) fails acceptance with "the diff could not be read", and that failure is now classed `stale-merge-ref` and routed to "push or update the branch", not `own-defect` -> `owner` (a11ign/a11ign#5565, the row agent-org#1524).

`src/acceptance-commands.ts` `changedFilesOfThisPullRequest` names the cause when HEAD still has fewer than two parents after the one-level deepen: "the merge commit this run checked out is not a parent-bearing merge: re-push or update the branch; a rerun reuses it" (it used to say "HEAD is not a merge commit"). `src/ci-failure-class.ts` gains the class `stale-merge-ref` and the route `push-or-update-branch`. `readCiFailure` sets the fact `staleMergeRef` (present only when true) when the job log says the diff could not be read. The rule with no provider puts it after a lost runner and before `main`; the provider is offered the class only with its fact, as `waiting-on-pin-bump` is. The order's route text says a push or `update-branch` is needed and that "a rerun reuses the same merge commit and cannot clear it".

Region: `src/acceptance-commands.ts`, `src/ci-failure-class.ts`, their tests (`src/ci-failure-class.test.ts`, `src/packaging/acceptance-commands.test.ts`).

Acceptance:

```bash
cd ~/repos/wt-agent-org-1524 && node --test src/acceptance-commands.test.ts src/ci-failure-class.test.ts
```

Closes a11ign/agent-org#1524

Measured at this head: `node --test src/acceptance-commands.test.ts src/ci-failure-class.test.ts` -> `tests 52, pass 52, fail 0`. `src/ci-failure-class.test.ts` alone -> `tests 32, pass 32`. `src/packaging/acceptance-commands.test.ts` -> `tests 307, pass 307`. `pnpm run typecheck` -> exit 0. The repository has no `lint` or `verify` script (`package.json` defines `test` and `typecheck` only), so no lint was run.

Full `pnpm test`: 113 of 11813 tests fail in 26 files. The SAME 113 fail with the HEAD versions of the four changed files, in the same 26 files (the failing test names are identical on both runs), so none of them is caused by this change. They are not investigated here.

Positive control (the stale-merge-ref reading): before the change the POSITIVE test fails (the fixture log is classed `own-defect`, the fact is absent); after it passes. Negative control (a diff that was read and a test that failed): `own-defect` -> `owner`, passing before and after.

Mutation checks, each run against the changed source and restored byte-identical (`diff` shows no change afterwards):
1. the fact is never read: POSITIVE fails;
2. the guard matches every log: NEGATIVE fails (and the #5151 POSITIVE, which assumes an ordinary log);
3. stale-merge-ref placed after `main`: the rule test fails;
4. the provider is offered stale-merge-ref without its fact: the provider-criteria test and the rule test fail;
5. the acceptance why is the old state: the #2305 wording test fails.

Done-when 3 (was `18f0366` unreachable?): inferred, not proven for every ref. `git fetch --depth=1 origin 18f036660f46bc22681766afb9d1cf7a354174de` succeeds (GitHub serves the object by SHA), and `git cat-file -t` reports `commit`; its parents are `0819ae1b...` (the base the PR was first opened on) and `b9cff1e8...` (the PR head). `git merge-base --is-ancestor 18f0366 FETCH_HEAD` is NOT an ancestor of `refs/pull/5565/merge` (`0b09653a`, the merge commit the later run checked out) nor of `refs/pull/5565/head`. The inferred cause: `18f0366` is a superseded merge that no branch ref reaches, so `git fetch --deepen=1 origin` never brings in its parents, and a rerun, which reuses the event's `github.sha`, checks it out again. I did not run a reachability check across every ref in the repository.

Assumptions (judgment calls, in the task log): the route keys on the acceptance gate's phrase "could not be read the diff" in the log, which also covers a `git said:` error from the diff reader. Such a git error would be routed to push or update the branch, not to a rerun. The new wording is in the PR's test, not in a new test under `src/acceptance-commands.test.ts`.

platform: GitHub's `refs/pull/<n>/merge` and the `actions/checkout` depth-1 merge commit; nothing added beside them.

🤖 Generated with [Claude Code](https://claude.com/claude-code)
