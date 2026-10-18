---
"agent-org": minor
---

A new setting, `tickets.prReview`, names the skill a ticket worker runs on its whole diff before it pushes or opens a pull request, such as `"a11ign:clean-code-review"`. When it is set, the worker's brief has it run after the last commit, with the repository's checks re-run after each fix, and the pull request's body records it in a `Pre-PR review:` line that `pr:open` checks. The ticket hook refuses `gh pr create`, `pr:open create` and `git push` until that skill has run since the last commit, and it logs each review and commit in a file beside the outcome file, which no worker may write. A review round is gated the same way. With the setting absent, nothing changes: the brief, the hook and `pr:open` behave as before.
