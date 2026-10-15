---
"@a11ign/agent-org": patch
---

A hold-reminder order quotes the manager direction posted on the held pull request (a11ign/agent-org#1397). The order that wakes a holder, and the decision asked of the escalation seat, were built from the hold's own facts, so a manager comment posted after the hold, such as "drop your hold", never reached either. Both now quote the newest three manager directions posted after the hold, verbatim and attributed by seat and author, each cut at 1200 characters, and name how many older ones they leave out. A manager comment counts only when its last `decided-by` marker names a manager seat; a comment with no seat marker is not quoted.
