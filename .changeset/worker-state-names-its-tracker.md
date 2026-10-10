---
"agent-org": patch
---

`agent-org worker:state blocked <row> <reason>` no longer labels the FIRST tracker's row of that number (a11ign/agent-org#460). The row is resolved and never defaulted: a keyed reference (`agent-org#460`, or `owner/name#460`) names its tracker, an undeclared key is refused by name, and a bare number that is a row in several declared trackers is read from the claim (the one whose row carries the session's own claim label) or refused naming every candidate. A `blocked` declaration on a CLOSED row is refused by name, with the reopening it would need. The declaration file records the resolved repository, and the gate no longer reads a declaration for another repository's row as an excuse for this claim.
