---
"agent-org": patch
---

`calibrateFloors` (`src/confidence-floors.ts`) reads the model-routing decision log and returns, per question, the lowest confidence floor at which the routing's answers were right at 0.8 over at least 30 judged answers, or the flat 0.7 with the reason it stands (a11ign/agent-org#1205). Pure: it reads no file and writes nothing, so it ships inert until a11ign/agent-org#1445 has it set the floors the provider reads.
