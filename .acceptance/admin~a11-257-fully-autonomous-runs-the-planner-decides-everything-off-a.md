Refs A11-257

Step 1 of 3 (agent-org): one escalation list decides what reaches a person. `src/ticket-mode/escalation.ts` holds the seven items as data, and the planner brief (single and batch), the worker brief, the review-round brief, the shipped house notes and the reviewer's prompt quote it. A `needs-human` outcome names its item in `escalation` and a `QUESTION.md` starts with `**Escalation:** <id>`; the Stop hook refuses a stop that names none (bounded by the usual two refusals; a Talk session, a new-ticket run and a publish run are exempt), and the board starts the card's reason with the item's words, or "Off the escalation list:". The planner no longer stops for a behaviour grill: a screen plan must carry `**Behaviour:** settled by the planner`, and a `Product:` bullet is no longer refused. Pick and the queue hold no ticket for an open decision. A disputed review is answered with a reply that quotes the decision, and the round ends `reviewed`. The reviewer is bound by the plan's decisions (`ReviewBrief.planDecisions` and `ReviewBrief.escalation`, reviewer contract 1.8) as well as the ticket's, in the order the ticket's Decisions, the plan's decisions, the plan's text, its own rules.

Acceptance:

```bash
# escalation-stop.test.ts: "a planner question off the list is refused and settled in the plan", "an on-list question still stops", the exemptions, and the board's card text
# worker-files.test.ts: "a worker's unplanned choice appears in the pull request, not as a stop", and the planner briefs that no longer stop for a behaviour grill
# prompt.test.ts: "a reviewer does not re-raise a planned decision" and the reviewer's order of authority; (the plan decisions reaching the brief are checked in pool-reviewers.test.ts by the suite)
# escalation.test.ts, plan-decisions.test.ts, open-decisions.test.ts: the list, the plan's decisions, and the plan check for a screen's behaviour
# queue.test.ts (the filing check cannot run pool.test.ts, server.test.ts, pool-answer.test.ts, pool-reviewers.test.ts or cli.test.ts, which CI's suite runs): no ticket is held for an open decision, a Product: bullet is attached, and a screen plan without the planner's behaviour line is refused
npx rstest run --config scripts/rstest/rstest.config.ts src/ticket-mode/escalation.test.ts src/ticket-mode/escalation-stop.test.ts src/ticket-mode/plan-decisions.test.ts src/ticket-mode/open-decisions.test.ts src/ticket-mode/worker-files.test.ts src/ticket-mode/review-round-dispute.test.ts plugins/atomic-reviewer/prompt.test.ts src/ticket-mode/hook.test.ts src/ticket-mode/hook-claims.test.ts src/ticket-mode/queue.test.ts src/ticket-mode/plan-stamp.test.ts src/install/house-notes.test.ts src/plugins/built-in.test.ts plugins/atomic-reviewer/index.test.ts
npm run typecheck
```
