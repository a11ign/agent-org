---
"agent-org": patch
---

A row being filed is not read as having no state label (a11ign/a11ign#4048). `row-file` adds the state label last on purpose, so every filing has a 12 to 13 second gap with none, and a tick that read in it tripped `row-without-exactly-one-state` and `board-disagrees-with-reality` three times on 2026-10-08. `stateLabelFindings(rows, { now })` now excuses a `NONE` row younger than `FILING_GRACE_MS` (5 minutes); `MANY` is a finding at any age, and a `createdAt` that is absent or unparseable is judged, never excused. `rowsBeingFiled` names the excused rows, `boardTruthAudit` returns their count as `filing`, and the daily table says `N filing, not judged` beside `N disagree`. A caller that gives no `now` excuses nothing. The tick's own reads (`readOpenRows`, `stateLabelReading`) do not yet carry `createdAt` and `now`: that wiring is outside this row's Region and is named on the row.
