---
"agent-org": patch
---

`row-file --board=<n>` on an `epic` no longer adds `backlog` beside `epic` (a11ign/agent-org#493, found on a11ign/a11ign#4505). #4456 boarded an epic "at Backlog" by giving it the `backlog` label as well as the Backlog Status, so the daily board check read the row as carrying two state labels and reported it as disagreeing with itself. An epic now gets Status `Backlog` and its lane label and keeps `epic` as its one state label; a row that is not an epic boards exactly as before (`ready`, Status Ready).
