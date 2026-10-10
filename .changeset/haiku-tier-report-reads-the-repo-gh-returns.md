---
"agent-org": patch
---

The Haiku trial report (`src/trace/haiku-tier-report.ts`) finds each closed row's pull request again: it builds the repository from `repository.owner.login` and `repository.name`, the shape `gh issue list --json closedByPullRequestsReferences` returns (it has no `nameWithOwner`), where it read the bare repository name and printed "0 with a merged pull request" and "first-pass merge: none merged" for every row, so stop rules (a) and (b) could not be read. A closing pull request whose repository names neither now stops the report with the row's number instead of matching nothing. a11ign/agent-org#530.
