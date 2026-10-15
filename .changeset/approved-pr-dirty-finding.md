---
"@a11ign/agent-org": patch
---

org-health can name an approved pull request that has been DIRTY for more than 30 minutes with no push to its head, with its age, and clears it when the PR rebases or merges (agent-org#1168). It sits behind `health.approvedDirty`, which ships OFF, so nothing changes until that switch is decided on. Two readings ride the same switch: a PR carrying 3 or more `hold:` labels, and a head whose last two runs failed the same jobs.
