A DIRTY worktree is removed once its work is a ref the prune can read back (a11ign/agent-org#728, for a11ign#4620 and incident #3846). Before, `prune-worktrees` left every tree with a modified tracked file, and every unmerged tree with commits, for a person, so the disk filled with trees whose work was already safe on a branch.

Closes a11ign/agent-org#728

## What changes, and why

- **`src/prune-worktrees.ts`.** `recoveryFor` reads a tree the merge test calls DIRTY: ACTIVE first (a tree touched in the last ten minutes is never read further), then untracked non-ignored work (stays DIRTY, named), then HEAD, then for a named branch `git rev-parse --verify refs/heads/<branch>` equal to HEAD (commits only: removable like a merged tree); a detached HEAD with no tracked edit has no ref to read back and stays DIRTY. `salvageTracked` runs `git stash create` (tracked edits only; its first parent is HEAD), `git update-ref refs/salvage/<tree>-<epoch> <sha> ""`, and reads each ref back with `rev-parse --verify --quiet <ref>^{commit}`; a detached HEAD is pinned first as `<tree>-head-<epoch>`. A ref that already holds the same tree and first parent is reused, so an hourly run does not add a ref per pass. Any failure leaves the tree DIRTY with the reason on its line.
- **Removal needs no `--force`.** `git worktree remove` refuses a modified tree. After the salvage is read back, `git diff --quiet <salvage commit>` must show the working tree equals what is pinned, and only then `git reset --hard HEAD` discards it, so the tree is clean when `git worktree remove` runs. An edit made after the salvage fails the diff and is never discarded.
- **Shared with the merged path.** The row claim (#2782) is taken before any ref is written; the HELD/unverified-record/runs refusals, the 25-per-run limit, `nice` and the 250 ms pause are the same code (`pruneEntry` hands the recovered tree to the same `heldUnlessReleased` -> `claimThenRemove`).
- **Report.** `[recovery]` names each salvage ref beside its tree and a DIRTY line carries its reason. `refs/salvage/*` is written and never pruned (nothing in the prune lists or deletes it).
- **`src/prune-worktrees-commits-only.test.ts`.** 21 tests on real temp git repos, each positive with its control.
- **`.changeset/a-dirty-tree-is-removed-once-its-work-is-a-ref.md`.** A patch.

## How you verified it

```
$ AGENT_ORG_HOST=/home/agent/repos/a11y-witness/.agent-org/host.json node --import tsx --test src/prune-worktrees-commits-only.test.ts src/prune-worktrees-closed-row.test.ts
tests 31, pass 31, fail 0   (21 new + 10 closed-row, which still pass untouched)
$ node --import tsx --test src/packaging/prune-worktrees.test.ts and the related packaging suites   # 270 pass, 0 fail
$ npx tsc --noEmit -p tsconfig.json     # only the two pre-existing mjs-ratchet.test.ts errors
```

Acceptance: `AGENT_ORG_HOST=/home/agent/repos/a11y-witness/.agent-org/host.json node --import tsx --test src/prune-worktrees-commits-only.test.ts src/prune-worktrees-closed-row.test.ts`

Mutation: `src/prune-worktrees.ts` copied aside, one change at a time, restored from the copy and `diff`ed byte-identical (empty) after the run. Red counts are of the 21 new tests, measured by running them: the HEAD-equals-ref check never fires -> 1 red; recovery always refuses -> 20 red; the salvage ref never written -> 9 red; the ACTIVE check never fires -> 1 red; the discard skipped (git then refuses the tree) -> 8 red; untracked work ignored -> 1 red; the diff guard before the discard dropped -> 1 red; the read-back compares nothing -> 1 red; the detached HEAD not pinned -> 1 red; `removeByRef` always on -> 1 red; `main()` not passing `removeByRef` -> 1 red. Each was red in the new file only; the closed-row file was not rerun under the mutations.

## Anything a reviewer should be sceptical of

- **The new path is OFF by default in `pruneWorktrees` and ON in `main()`** (`removeByRef`). `prune-worktrees-closed-row.test.ts` (NEGATIVE 3/3) and `src/packaging/prune-worktrees.test.ts` pin "a dirty tree is left", and are outside this row's Region and Acceptance; changing them is the `product-manager`'s to amend. The CLI (`--apply`) behaves as the row asks.
- **`git reset --hard HEAD` runs in a tree about to be removed**, after the salvage is read back and the diff against it is empty. It is the only way to remove a modified tracked tree without `--force`, which the row forbids. If anything between the diff and the reset changed a file, `git worktree remove` refuses and the tree stays DIRTY with the refs named.
- **Out of scope, left a person's:** a cherry-picked tree (its commits are not on a branch by sha, even with tracked edits), and a detached clean tree that is not merged. Untracked non-ignored files are never salvaged (`stash create` is tracked-only), so such a tree stays DIRTY, named.
- **Not this row's:** a git refusal in the ordinary (merged) removal path throws and aborts the run; that is today's behaviour, and the new path catches its own refusals so it cannot starve a run. The count against 127 after install is not measured here.
- **The role file `.agent-org/roles/engineer.md` is not in this repository's tree**; I read the copy in the `a11y-witness` sibling checkout.
- **The row's Acceptance command `cd`s into `/home/agent/repos/agent-org`**, the main checkout, which does not hold this branch; the command above is the same two files run from this tree, with the host set.
