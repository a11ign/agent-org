---
"agent-org": patch
---

The gate asks for the timelines of the answer-given lane together instead of one after the other. `answerGivenOrders` read one `issues/{n}/timeline` per touched claimed row through the synchronous `gh`, so the lane cost the sum of its reads; the reads now go out as one batch (`readWithFirstWaveTogether`, the one the other repositories' reads use), and the commands, the orders and their order are unchanged. Every touched live row is read, even where the 8-order cap would have stopped the old loop early, because a row's order count is known only after its timeline is read; the orders returned are still the first 8. A refused timeline is that row's silence and nobody else's. a11ign/a11ign#3566, slice 3 of the tick's cost.
