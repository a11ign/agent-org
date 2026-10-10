---
"agent-org": patch
---

A filed stuck-cause row is asked once more an hour after it is answered, as a label row is. #622 closes the filed row when `answer:ceo` is removed, but `escalateStuck` called `reaskCleared` only for a label row and the filed row's key stays in the ledger's `escalated` set, so a cause still true after the close was silent until its causeKey changed. For an `ALREADY ESCALATED` filed-row key with no open row of its title, `reaskFiledRow` now reads the rows of that title and, when there is exactly one, closed at least `REASK_AFTER_MS` ago, files the row once more through `fileRepositoryRow` with a comment naming the one that asked before. The once-rule's memory is the closed rows of the title read back (a second closed row is never followed by a third), so the ledger is not touched. The closing comment now says so. a11ign/agent-org#656.
