# The readiness score's offline test

`result.json` is the latest check of the readiness score (A11-443, `src/ticket-mode/readiness.ts`) against how past tickets' runs went. It scores the tickets with the board's own scorer (the same prompt, model and bounds), and sets each score beside the ticket's history: its runs and their rounds and Needs-you rounds from M1's outcome records (`<stateDir>/tickets/outcomes.jsonl`), and its re-plans from the queue's run log. It is the public part of the result: ticket keys, scores and those counts. The tickets' text and the model's reasons stay on the host that ran it, in `<stateDir>/evals/readiness/`, because this repository is public.

The set is the 10 tickets whose first recorded run is oldest (A11-429's cap of 10 tickets per eval set).

`tickets.readiness` is on by default only when `score.meetsBar` is true here: at least 3 tickets scored under 60 and at least 3 at 60 or more, at least one measure (rounds per run, re-plans or Needs-you rounds) where the low tickets' mean is 1.5 times the rest's, and none where they did better. A test holds the default in `src/ticket-mode/settings.ts` to it.

To run it again, put the picked tickets' `{ key, title, project, description }` in `<stateDir>/evals/readiness/tickets.json` (the script names any it is missing) and run `node scripts/check-readiness.ts` on that host. It stops before a ticket once `tickets.evalTokenCap` is spent.
