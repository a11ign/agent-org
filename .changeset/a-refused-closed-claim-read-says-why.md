---
"@a11ign/agent-org": patch
---

A refused closed-claim read says why (a11ign/agent-org#948). `readClosedClaimedRows` no longer swallows the `gh` failure: the refusal is logged as `closed-claim: the read of <repo> was refused: <cause>`, with gh's first stderr line, else its exit status or signal, else the error's message, and a bad JSON answer or a null `data.repository` say so in their own words. The tick's UNREAD line names the same repository so the pair reads together. The read still answers `null`, never an empty list.
