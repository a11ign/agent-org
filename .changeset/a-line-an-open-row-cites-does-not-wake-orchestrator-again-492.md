---
"agent-org": minor
---

A repeating log line that an open row already cites no longer wakes `orchestrator` again. `repeatingLinesTick` takes a `settle` hook, and the gate passes `settleCitedRepeatingLines` (`src/work-gate.ts`): each line the detector would order is looked for, by its normalised first 80 characters, in the rows the tick already holds; a candidate is re-read through the ticket port (`readItem`) and counts only if it is still open and still carries the line. A cited line is dropped from the tick's orders and its count is written to the row as a `postDecision` comment at 30, 60, 120 ... consecutive ticks. An unreadable row, a closed one, a body without the line, a needle under 30 characters or a failed lookup all leave the order as it is today. `A11IGN_REPEATING_LINE_SUPPRESSION=off` restores every order. Rows of a scope that declares no tracker (`a11ign/agent-org`) are not seen, so their lines still wake the seat. a11ign/agent-org#492.
