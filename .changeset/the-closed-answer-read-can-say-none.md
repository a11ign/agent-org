---
"agent-org": patch
---

The gate's closed-answer-rows read says "none" for a repository with no `answer:` label. `gh label list --json` prints ZERO BYTES, not `[]`, when nothing matches, so `readClosedAnswerRows` threw on `JSON.parse("")` and returned `null` -- a refusal -- and the tick printed `NOTE: could not read the closed rows that still owe an answer` on every tick since a11ign/agent-org became a declared tracker (325 ticks by 2026-10-09T20:40Z). An EMPTY stdout is now no labels (`[]`); text that does not parse, a non-array and a thrown `gh` stay `null`, so the day a closed agent-org row owes an answer the line still means what it says. a11ign/agent-org#472.
