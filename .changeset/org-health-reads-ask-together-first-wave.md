---
"@a11ign/agent-org": patch
---

The org-health pass asks its `gh` reads together through the first-wave mechanism (agent-org#1225): the release runs, release failures, fleet-build incidents, team access, the latest merge and the board's reads are read as one wave, and the effects (raising release incidents, lifting holds, posting the board's truth) run after it on the data that wave read, once. The class-repeat rows and the release-behind cache stay effects, outside the wave. The tick's `gh` spawn count on the org-health fixture is held at a ceiling in `docs/gh-call-baseline.json` by `src/packaging/tick-budget.test.ts`.
