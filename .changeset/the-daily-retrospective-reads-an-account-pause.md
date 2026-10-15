---
"agent-org": patch
---

The daily retrospective reads the Claude allowance's pause from `account-limit.ndjson`: one line says how much of the 24 hours Claude work was held (`Claude work paused 22h51m of 24h`, or `not paused`, or `unknown` when the log cannot be read), and the idle minutes leave out the ticks that started inside the pause, saying how many minutes were excluded. A `worse` read on a day the pause covered more than half of is `paused`, not a regression. On 2026-10-15 the five numbers that read worse were all the 23 paused hours, and the retrospective filed them as an org failure (agent-org#1429).
