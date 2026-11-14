---
"agent-org": minor
---

A worker's Needs-you question whose answer is already written down can be answered before a person is asked (A11-438, off by default). With `tickets.autoAnswer: true`, a cheap model (`tickets.autoAnswerModel`, `haiku` by default) reads the ticket, its parent, their files, the repository's AGENTS.md, CLAUDE.md and README.md and the Decisions of the other tickets on the board, and answers a question that names no item of the escalation list, or the `reserved` or `contradicts` item, when it is at least `tickets.autoAnswerThreshold` sure (0.9 by default) and cites its sources. The run carries on with the answer, its card shows the answer with its sources, and a person overrules it through the answer route. Every other question waits on a person as before. `GET /api/interventions` counts automatic answers and a person's answers apart (`autoAnswers`, `personAnswers`).
