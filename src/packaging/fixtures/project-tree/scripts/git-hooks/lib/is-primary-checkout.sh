# IS THIS THE FLEET-DRIVING CHECKOUT? — asked of an explicit local mark, never inferred from the tree.
#
# ## Why not `.git` being a directory, which is what both hooks used to ask
#
# That predicate is CORRECT for the question `prune-worktrees.mjs`'s `isPrimaryWorktree` asks — *within one
# repository, is this the primary worktree or a linked one?* A linked worktree's `.git` is a text file; the
# primary's is a real directory. The hooks borrowed it for a different question — *is this the one machine
# that drives the fleet?* — and it does not answer that one at all, because **a real `.git` directory is
# true of every ordinary clone.**
#
# Measured 2026-09-07, issue #198: `core.hooksPath` is committed, so `post-checkout` travelled to the lab
# with a `git pull`. `run-job.yml` then does the one thing it forbids — `git checkout --detach <sha>` at
# the ref you asked for, which is how EVERY lab job runs at a branch — and every
# `lab:job -e ref=<branch>` began failing. `-e ref=main` still worked, so it presented as "branches are
# broken" rather than as a hook.
#
# The same predicate, correct for one question and wrong for another. It is the third population-boundary
# defect in two days (#164, #174) and the inverse of both: not a guard reaching too few paths, but one
# reaching too many MACHINES — and the most expensive, because it does not report a false finding, it
# stops work.
#
# ## Why LOCAL git config, specifically
#
# `git config --local` lives in `.git/config`, which is **not cloned and not pulled**. That is the whole
# property being relied on: a lab pull, a worker deploy or a colleague's clone cannot acquire the mark,
# and no file in the tree can carry it there by accident. An untracked marker file would work too and is
# one `cp` away from travelling; an absolute path breaks the moment this checkout moves.
#
# ## It is OPT-IN, and that gap is REPORTED rather than hidden
#
# An unmarked checkout is not guarded. That is the correct default — a guard that fires on machines it was
# never meant for is what this fixes — but "unmarked" and "safe" must not read the same, so `npm run
# doctor` reports an unmarked primary and `agent-org primary:mark` sets it. Silence here would be the
# check-that-examined-nothing shape one layer down.
#
#   git config --local a11y.primaryCheckout true     # what `primary:mark` runs
#
# Sourced by `pre-commit` and `post-checkout`. ONE copy, because two spellings of "which machine is this"
# is exactly the fact-stated-twice shape, and the two hooks disagreeing would be silent.
# ## BOTH conditions, and the first version of this fix got that wrong
#
# The mark alone is not enough, because **a linked worktree shares `.git/config` with the repository it was
# created from** — `git config --local` in a worktree reads the primary's file unless
# `extensions.worktreeConfig` is set. So marking this Mac would have marked every worktree off it, and
# `pre-commit` would have refused commits in the very worktrees every agent works in. Caught by
# `primary-checkout-guard.test.ts`'s two linked-worktree cases, which is what they are for.
#
# So the two predicates answer two different questions and both are required:
#
#   .git is a DIRECTORY   this is the primary worktree, not a linked one   (prune-worktrees.mjs's question,
#                                                                            where it is exactly right)
#   the MARK is set       this clone is the fleet-driving one, not the lab, a worker, or a colleague's
#
# #198 was using the first to answer the second. The fix is not to replace it but to add the one it was
# standing in for.
is_primary_checkout() {
  # A linked worktree's `.git` is a text file (`gitdir: ...`); the primary worktree's is a real directory.
  [ -d "$(git rev-parse --show-toplevel)/.git" ] || return 1
  [ "$(git config --local --get a11y.primaryCheckout 2>/dev/null || true)" = "true" ]
}
