# A11-275, step 2 of 2: an ask only the person's session can do waits on the session's queue, never on Needs you

A worker that needs something only the person's session can do (running a command on the person's machine, reading the board, a live check against a release) declares a `session` wait: `{ "kind": "working", "waitingOn": [ { "session": "<the exact command, where it runs, and what a pass looks like>" } ], "until": "<ISO time>" }`. The run is In progress, waiting, and never Needs you. The board lists the ask in the session's queue (`GET /api/session-asks`, as `kind: "waiting-run"`, after the After-merge checks); the session answers with `POST /api/session-asks/<KEY>/answer` and `{ "ask", "result" }`. The result is kept in `session-answers.json` in the board's tickets directory, finishes the wait at the board's next read, and is in the prompt that wakes the worker. The wait is never failed and never late on its own: the worker's `until` bounds it. `ESCALATION_RULE` (quoted into every brief and the stop hook's off-list refusal) and the shipped house notes tell a worker that such an ask is a `session` wait and not a stop.

Acceptance:

```bash
# wait-parse.test.ts, outcome.test.ts: a `session` item parses and is held to the shape check; wait-read.test.ts: pending until a result is recorded, then finished, unreadable when the seam throws
# wait-verdict.test.ts, wait-text.test.ts: the finished line quotes the result; the card reads "asked, no answer yet" and "answered"; wait-note.test.ts: the run is waiting, never stalled or Needs you
# session-asks.test.ts: a waiting run is listed as a waiting-run ask; session-answers.test.ts: the answer is recorded, refused or accepted again as the plan says, and the route needs the board's key
# escalation.test.ts, escalation-stop.test.ts, house-notes.test.ts: the rule and the notes name the `session` wait and both routes, and a needs-human for such an ask is refused with those words
# (the filing check cannot run session-asks.test.ts, session-answers.test.ts, escalation-stop.test.ts or pool-session-wait.test.ts, which CI's suite runs: the waiting-run listing, the answer route and its refusals, the hook's refusal, and the pool end to end: a declared `session` wait reads In progress, the ask is listed, the answer wakes the worker once with the result, and an answer to an earlier declaration finishes no later one)
npx rstest run --config scripts/rstest/rstest.config.ts src/ticket-mode/wait-on src/ticket-mode/outcome.test.ts src/ticket-mode/escalation.test.ts src/install/house-notes.test.ts
npm run typecheck
```
