---
"agent-org": patch
---

`node src/provider-confidence.ts --since 24h` reads the decision log and prints, per use and question, the decisions asked, the share the provider answered and the floor held back, the fall-backs for any other reason (a refusal, a 422, a timeout: counted apart, never as low confidence), the mean and median confidence, and the floor. A log line it cannot read is counted and named by its position; with no provider decisions in the window it says `no provider decisions in the window`. The reading is `confidenceReading` and `formatConfidenceReading` in `src/provider-confidence.ts` and is pure, so posting it daily is a later wiring. a11ign/a11ign#4748, use 1 and 2 of a11ign/a11ign#4627.
