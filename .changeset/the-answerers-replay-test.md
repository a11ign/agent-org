---
"agent-org": patch
---

The answerer's offline test (A11-438): `node scripts/replay-auto-answer.ts` replays past Needs-you questions a person answered through the answerer and scores its agreement with the person's answers. `tickets.autoAnswer` turns on by default only at 95% agreement on at least 20 answered questions. The first replay, of 10 questions, answered none at the 0.9 threshold, so the key stays off by default.
