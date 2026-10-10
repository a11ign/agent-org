---
"agent-org": patch
---

Wake triage composes on the probability of the four questions that decide, not on five answers each over a flat 0.7 confidence floor (which for a yes/no means p >= 0.85). `compose` in `src/triage-provider.ts` digests iff P(informational) >= 0.65, P(asks the seat) < 0.3, P(names a red main) < 0.2 and P(names a chairman direction) < 0.2, and otherwise wakes; a probability not given wakes, and `repeat` is never a veto. `triageOrder` returns `probabilities`. a11ign/a11ign#4889.
