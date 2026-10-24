# A stacked pull request merges through the arm bot's stack merge, as the bottom open member of its stack

GitHub refuses auto-merge and plain merges for any pull request in a stack. It accepts only its atomic asynchronous merge (`PUT /pulls/{n}/merge-async`, which `gh stack merge` calls), and that merge takes every open member below as well.

We merge a stacked pull request with that API in `auto-arm.yml`'s `arm-approved` job, using its Octo STS token. That token is the only identity the repository grants a merge. We do it only when the pull request's base is the default branch, which means every member below has merged, and only after its required checks are green. The board never merges. A refusal is kept as a keyed comment on the pull request (`<!-- agent-org:stack-merge head=<sha> -->`) carrying the head it was given at, and it is retried when that head moves. When a stacked pull request turns ready after its approval, the board dispatches `arm-approved` again (A11-238, step 2).

## Considered options

- **Unstacking the pull request, then auto-merging it.** Rejected: GitHub's unstack removes every unmerged member, so the members above would lose their link.
- **The board merging with its own account.** Rejected: no board account may merge, and giving one that right would widen what a ticket-mode host can do.
- **Merging a member mid-stack along with the open members below it.** Rejected for now: the precondition would need every member below read for approval and checks. The bottom-only rule gets the same outcome one merge at a time.

## Consequences

- The merge API does not wait for checks as auto-merge does, so `arm-approved` reads `gh pr checks --required` first and does nothing, exit 0, while they are pending or red.
- `arm` (on `pull_request_target`) writes nothing for a stacked pull request. It used to go red on every push to one.
- The Octo STS policy is unchanged: `contents: write` for `auto-arm.yml` on `main` covers the merge, `pull_requests: write` the refusal comment.
