---
"agent-org": patch
---

A row labelled `needs:chairman` whose newest chairman-side event (a comment by the chairman's own login, or an answer comment opening with the messaging provenance line) is newer than its newest `labeled` event now orders `ceo` (`chairman-answered`) to take the label off or re-ask, keyed on the row and the event's time so it fires once per new event. Two REST calls per labelled row and none when nothing carries the label; a row whose timeline could not be read is reported on stderr, never counted as unanswered (a11ign/a11ign#3390).
