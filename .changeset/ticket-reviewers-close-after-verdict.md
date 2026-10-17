---
"agent-org": patch
---

Ticket mode's reviewer workspaces are closed once their verdict is posted, and a pull request that has merged or closed has its reviewer workspace and its `~/reviews/<seat>` checkout removed, so the tickets session no longer holds a workspace for every merged pull request. A checkout with uncommitted changes (mutation leftovers, say) is reported in the log with the paths it had, then removed. A head that moves still starts a fresh reviewer, and a reviewer is still never started twice for a head while its pull request is open; a pull request GitHub shows merged or closed is not started (A11-81).
