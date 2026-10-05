---
"agent-org": minor
---

`pr:open` labels a new pull request with its owner when the tree carries no `.a11y-owner` stamp (a11ign/a11ign#3639). agent-org's trees are made by hand with `git worktree add` and nobody stamps them (5 of 207 on the agent host, 2026-10-05), so three of the four open pull requests that day had no `session:` label and a red one could not be routed to anyone. The owner is now read from the row the pull request names (its `Closes` line, or an `owner/repo#N` in its title): exactly one `session:` label across the named rows labels the pull request, and no row, a row with no `session:` label, or rows naming two different sessions leaves it unlabelled as before. A stamped tree is unchanged and never reads a row. The label is also created in the repository when GitHub says it is absent, since `gh pr edit --add-label` of a label that does not exist is "not found"; a failure to read the row, to look the label up or to create it is printed, never swallowed.
