Closes A11-257

Step 3 of 3 (agent-org): the person-interventions health number. A run that goes to Needs you adds one to its UTC day (`logEvent` counts a "needs-you" event once, in `src/ticket-mode/queue/interventions.ts`), and a fix a chairman session records with `POST /api/interventions` (`{ "what": "...", "key": "..." }`, the board's key as every POST needs) adds one more. The tally is `Queue.interventions`, kept for 30 days and saved with the queue. `GET /api/interventions` answers the last 7 days, oldest first, with today's total (`GET /api/health` stays the loop's, A11-282). The built UI's pool bar shows "Person interventions today: N", the 7 days in its title, and nothing while the number is unread or its read failed. Steps 1 and 2 (the escalation list, the briefs, the hook, the reviewer, and the plugin's skill) are merged.

Acceptance:

```bash
# interventions.test.ts: a needs-you event adds one to its UTC day, a fix adds one, days older than 30 are dropped, the same event logged again is not counted twice, the tally survives a restart, and the 7-day view
# server.test.ts: "/api/interventions answers the last 7 days and today's total", "refuses a fix with no `what`", "over HTTP, recording a fix needs the board's key"
# loop-load-routes.test.ts: the load script times the new GET route
# ui/src/runs/health-number.test.tsx: the text, its title, 0 shown as 0, nothing while loading or failed
npx rstest run --config scripts/rstest/rstest.config.ts src/ticket-mode/interventions.test.ts src/ticket-mode/run-log.test.ts src/ticket-mode/server.test.ts src/ticket-mode/loop-load-routes.test.ts
npm run typecheck
pnpm --dir ui exec rstest run --config rstest.config.ts src/runs/health-number.test.tsx
pnpm ui:typecheck
```
