---
"agent-org": patch
---

An `answer:<session>` label is no longer added to a closed row, or to a row whose newest comment asks that session nothing (a11ign/a11ign#4679). The board-truth handoff writer (`readProseAndOrder`) re-raised handoffs already answered and cleared on every edition day: 56 labels landed on closed and answered rows in one minute, each waking its owner with nothing to answer. It now asks `answerLabelRefusal` first, which also refuses a label already given since the newest comment and a row it could not read, and says each refusal on the log.
