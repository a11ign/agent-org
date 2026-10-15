---
"@a11ign/agent-org": patch
---

The `answer-owed` decision class exists (a11ign/agent-org#905, Move 3 of a11ign/a11ign#4505): a worker's scope question on one row can be answered by a one-shot run, Haiku by default and Sonnet when the provider picks it or answers under its floor. `answered` posts the decision and removes `answer-owed:<session>`, `relabel` moves it to a session from a closed list, and `escalate` (also the default, and the only answer for a ruling, rule change, admin write or chairman decision) writes nothing and returns the order to the standing seat. The class is a file; `seatModeOf("answer-owed")` stays `seat` until a project says otherwise.
