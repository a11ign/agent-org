---
"agent-org": patch
---

A batch planner that hands tickets back keeps its terminal open for the person: each ticket it asked about or wrote nothing for waits (Needs you) on the batch's one pane, its card says "Planned together with A, B, C: answer in the batch's terminal", and every one of those cards links to that same pane, where the planned tickets have already left. When the person answers there and the run writes `planned` again, the tickets it still holds are settled the same way. A parked pane is never closed as a "leftover" by a queued round or Talk, which waits for the person instead. Talk opens one pane for a run, and for a batch's tickets together, and shows "Talking" on the card, not Planning; pressing it again does nothing on the board and the page goes to the same named tab.
