---
"agent-org": minor
---

The board counts person-interventions per day (A11-257): each run that goes to Needs you adds one to its UTC day, and each fix a chairman session makes by hand and records with `POST /api/interventions` (`{ "what": "<what was fixed>", "key": "<ticket, optional>" }`) adds one more. The tally is kept for 30 days in the queue file (`Queue.interventions`), `GET /api/interventions` answers the last 7 days with today's total, and the built UI's pool bar shows "Person interventions today: N", with the 7 days in its title. The loop's own route, `GET /api/health`, is unchanged.
