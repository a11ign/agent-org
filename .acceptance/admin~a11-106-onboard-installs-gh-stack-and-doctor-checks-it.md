## What it is

A stacked pull request keeps its base branch. When the pull request it sits on squash-merges and its branch is not deleted, GitHub does not retarget the stacked one, so it stays aimed at a dead branch and merging it never reaches `main` (a11ign/agent-org#1749, 2026-10-18). This change makes ticket mode move such a pull request to the default branch itself, and says on the board what it cannot move.

## Change

- `src/ticket-port/stack-retarget.ts` (new): a pure classifier, `baseKindOf`, and the sweep, `sweepRetargets`. The sweep reads each open pull request's base and state with the `gh` it is handed. Only a base that is the branch of one of the run's blockers is considered, since that is the base a stacked pull request has. Such a base that is the head of a merged pull request, with no open pull request on it, is moved with `gh pr edit --base <default>` and read back. A base on any other branch is the worker's own, and is left as it is. The head is never pushed, rebased or merged. A base whose branch is gone with nothing merged on it is not moved: it gets a note to retarget by hand. A base no pull request came from, and the default branch, get nothing. A pull request that cannot be read keeps its note and is asked again.
- `src/ticket-mode/pool.ts`: `retargetStacked()` runs the sweep over the open pull requests of each finished run that has a blocker with a branch, with a default-branch cache per sweep, and records the notes on the run when they change. A run that has not finished is not read or written.
- `src/ticket-mode/server.ts`: `retargetStacked` runs on its own interval at the feedback cadence, next to `releaseReviewers`, in its own try/catch.
- `src/ticket-mode/queue.ts`: an optional `retargets` field on an entry, by URL, set by `recordRetargets`; a retry or a review round drops it, as it drops `verdictNotPosted`.
- `src/ticket-mode/board-view.ts` and `src/ticket-mode/ui.html`: `retargetNote` shows the notes on a finished run. The run's status does not change for them.
- `src/ticket-mode/worker-files.ts`: the stack section says "your own pull request" (the acceptance criterion names that wording; it is a draft or ready as `tickets.drafts` says), and tells a stacked worker that agent-org retargets its pull request when the one it sits on merges, that a stale base is expected, and not to retarget, rebase, push or merge to fix it.

## Acceptance

Lint has no errors and typecheck passes. The retarget tests pass, and so do the ticket-port purity test (no spawner or `gh` name in `src/ticket-port/` other than the adapter) and the gh-call ratchet (no new `gh` call outside `src/ticket-port/`). The real retarget on a live repository was not exercised.

Acceptance: `bash -c 'set -e; npm run lint; npm run typecheck; P=$(mktemp -d); cp -r src/packaging/fixtures/project-tree/. "$P"; sed -i "s|@@PROJECT@@|$P|" "$P/.agent-org/host.json"; git -C "$P" init -q; git -C "$P" add -A; git -C "$P" -c user.name=ci -c user.email=ci@localhost commit -q -m fixture; AGENT_ORG_HOST="$P/.agent-org/host.json" npm exec -- rstest run --config scripts/rstest/rstest.config.ts src/ticket-port/stack-retarget.test.ts src/ticket-port/ticket-port.test.ts src/packaging/gh-call-ratchet.test.ts src/ticket-mode/pool.test.ts src/ticket-mode/queue.test.ts src/ticket-mode/board-view.test.ts src/ticket-mode/worker-files.test.ts src/ticket-mode/server.test.ts src/ticket-mode/ui-server.test.ts'`

Consumer-declaration: none -- `retargets` is optional on the queue entry and `retargetStacked` is an additional method on the pool; a queue file without the field loads as before, and a board that never sees a stacked pull request shows nothing new.
