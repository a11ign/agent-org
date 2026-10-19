## What it is

A ticket blocked by another waited for it to merge, though a branch is all stacking needs: the clean-code lint rows (A11-97..A11-115) sat Blocked on 2026-10-18 because their blocker was minutes into its run with no pull request, and because no repository was planned for them. This change stacks a run on its blocker's pushed branch, defaults a ticket's repository to its Linear project's, and has agent-org rebase a stacked run when its blocker's branch moves.

## Change

- `project-repo.ts`: the repository a project's summary names, as one of the host file's clones.
- `board-view/settled-by-pulls.ts`: `repoOf` (the planner's repository, else the project's); `stackBaseOf` stacks on a blocker with a pushed branch or an open pull request in that repository; the wait reasons say why a run is Blocked; `rebaseNote` says what agent-org did to a stacked branch.
- `pool-start.ts`, `pool-tracker.ts`: the blocker's pushed head is read with `git ls-remote`, and each queued run's project repository from the tracker; a stacked run is rebased by `rebaseStacked` on the server's sweep, and a review round is rebased before it starts.
- `stack-rebase.ts`: the record of the branch a run was branched from (`stack-base.json`, written by `ticket:worktree --from`), when a rebase is due, and the rebase itself, from the recorded commit, with a lease on the run's own branch.
- `worker-files.ts`: the stacked-run section names a branch that is pushed with no pull request, and tells the worker never to rebase it; the planners are told each ticket's project repository.
- `ui.html`, `server.ts`, `queue/`, `worktree*.ts`, `batch-order.ts`: the board row, the sweep, the record, and the worktree that records its base.

## Acceptance

The unit tests of the change pass. The Done-when of the ticket (two tickets queued in a project naming one repository, the second starting on the first's pushed branch and both merging in order) is not run here: it needs the instance's Linear and GitHub credentials, which this worker does not hold.

Acceptance:
```bash
set -e
npm run lint
npm run typecheck
P=$(mktemp -d); cp -r src/packaging/fixtures/project-tree/. "$P"; sed -i "s|@@PROJECT@@|$P|" "$P/.agent-org/host.json"; git -C "$P" init -q; git -C "$P" add -A; git -C "$P" -c user.name=ci -c user.email=ci@localhost commit -q -m fixture
AGENT_ORG_HOST="$P/.agent-org/host.json" npm exec -- rstest run --config scripts/rstest/rstest.config.ts --testNamePattern "A11-116" src/ticket-mode/project-repo.test.ts src/ticket-mode/stack-rebase.test.ts src/ticket-mode/board-view.test.ts src/ticket-mode/worker-files.test.ts src/ticket-mode/worktree-command.test.ts src/ticket-mode/linear.test.ts src/ticket-mode/hook.test.ts src/ticket-mode/pool.test.ts src/ticket-mode/server.test.ts
```
