---
"@a11ign/agent-org": patch
---

The `row-off-board` decision class exists (agent-org#911, Move 3 of a11ign/a11ign#4505): the unlabelled remainder `settleOffBoardRows` cannot place is decided by a one-shot run instead of the standing `product-manager` seat. The question defaults to `backlog` and allows `backlog`, `ready`, `parked`, `epic` and `escalate`. `ready` is applied only for a row with no blocker, Waiting-for, `hold`, answer owed or future Not-before, `parked` only for a row that declares one of those, and `epic` boards at Backlog in lane any. `escalate`, an answer outside `allowed`, a row whose gap is gone and every other doubt return no action, so the seat decides. The tier question is Haiku by default and Sonnet when the provider's pick or confidence says so. **Nothing is switched on:** `seatModeOf("row-off-board")` stays `seat` until a project's `seats.json` says `run`, and deleting `src/decision-run/classes/row-off-board.ts` is the revert.
