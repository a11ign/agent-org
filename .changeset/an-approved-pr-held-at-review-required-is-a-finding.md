---
"@a11ign/agent-org": minor
---

The health check can now name an approved pull request held at `REVIEW_REQUIRED` for more than 10 minutes, with its age and the approving identity, behind the machinery flag `health.approvedRequired` (a11ign/agent-org#1248). The flag is OFF by default, so nothing changes until the flag is turned on. The finding says the approval does not count toward the merge rule (usually a permission or a rule that excludes the approver), not that a check is failing. A new head, a merge or a close clears it.
