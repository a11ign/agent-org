---
"agent-org": minor
---

Every round a ticket-mode run ends appends the run's outcome record to `<stateDir>/tickets/outcomes.jsonl` (A11-430, step 1 of 3): its model and effort, repositories, labels, each round's outcome, time and tokens by model (input, output, cache reads and writes), how many rounds handed it to a person, and its final state. A resumed round counts only the turns written after the round before it ended, so no turn is counted twice, and a message Claude Code writes once per content block counts once. A batch planning run's tokens are split evenly across its tickets, the remainder one each to the first, so the shares add up to the run's. A round whose transcript cannot be read writes no record and shows "Its tokens could not be read" on the run's Timeline. The run's Properties now show those tokens: before, a message's usage was added once per content block, and a resumed session's earlier rounds were counted again.
