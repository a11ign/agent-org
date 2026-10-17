---
"agent-org": minor
---

`pr:open` checks a ticket-mode run's pull request against its ticket, read through the tracker, where it read a GitHub row and so refused every pull request a ticket worker opened (A11-31's worker could not open its PR on 2026-10-17). The Region comes from the ticket's description and its plan files, the body names its ticket with `Refs <KEY>` or `Closes <KEY>` in place of `Closes #N`, the owner is the run itself, `tickets.drafts` decides whether the pull request opens ready or as a draft, and a changeset or a `no-release:` line is required where the repository has changesets. A ticket worker's brief now says to open its pull request with `pr:open`. A GitHub-row create is unchanged. (A11-74)
