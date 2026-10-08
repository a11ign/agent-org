---
"agent-org": patch
---

`no-merge-while-work-exists` reads the org's LATEST merge across the project and every keyed code repository the declaration lists, not the project's alone (a11ign#4047). It tripped falsely twice on 2026-10-08 while four `agent-org` pull requests merged and the product rows were date-held. `readLatestMerge` makes one `gh api` call per repository; a refused or unparseable read of any of them is `null` (unknown, stated) and never another repository's older time, and a repository with no merged pull request says nothing about the others. A trip's detail now names the repository of the last merge. The core-pool cost of the read is one call per declared code repository a tick instead of one.
