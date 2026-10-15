---
"@a11ign/agent-org": patch
---

An order the gate types into a pane carries an id, `wake:<session>:<epoch ms>`, and `agent-org order:verify <id>` checks it against the wake ledger: exit 0 when the gate delivered it to that session, 1 with the reason when it did not (a11ign/a11ign#5147). A holder the gate delivers the same causeKey to twice, with its PR head unmoved, files one failure entry and wakes `orchestrator` once. This runs only behind the decision switch `orders-verifiable`, which is off by default, so nothing changes until it is turned on.
