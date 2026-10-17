---
"agent-org": patch
---

A ready `lane:orchestrator` row with no file to commit now keeps the gate's order, so the standing `orchestrator` takes it, instead of becoming an engineer one-shot seat that has nothing to commit and ends on the stop hook's bound. The lane converts a row only when its Region declares a file to commit and does not say its deliverable is not a commit, the same test the ceo lane applies (a11ign/agent-org#1714).
