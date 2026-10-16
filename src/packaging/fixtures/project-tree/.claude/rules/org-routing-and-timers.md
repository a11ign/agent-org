## Timers and state

- **No session holds a standing cron.** After a restart, list them once and **`CronDelete` anything you
  find.**
- **THE CLOCK WAS NEVER THE DEFECT — the defect was that the tick WAS a model turn.** `work:tick` runs
  `work-gate.mjs` (no model) and hands what it finds to `wake.mjs`: **you are woken WITH the answer in
  your prompt, not to go and look.**
- **Do not create a cron to check for work.** If you want one, the gate is missing a question — add it to
  `work-gate.mjs`, where it costs an API call instead of a turn. A cron is right only for a WALL-CLOCK
  event, never for "has anything changed yet".
- **The row is the state.** Read the row, the PR and the API before acting on any message, `ceo`'s
  included.
- A product PR opens as a DRAFT and is marked ready only on a "convinced"; docs-and-tests PRs open ready.
  **Nobody merges by hand.**
- **`Acceptance:` and `Closes` are MERGE-BLOCKING** — a malformed body does not merge (a DUPLICATED
  `Acceptance:`, a MISSING `Closes`). A PR finishing no row declares `Closes: none -- <reason>`, em dash required.
- **A settled draft with no verdict goes to the external reviewer; an engineer reviews only when `ceo`
  names one** (#1394). A spawned engineer never claims a second row (#2407).

## `lane:ceo` protects review, not authorship (ceo, 2026-09-18)

- **A `lane:<owner>` label refuses any OTHER session unconditionally**, whatever a `Lane-exception:` line
  says. Keep one only for a DECISION; a PATH needing review re-lanes to `any`
  ([why](../../docs/operational-lessons.md#laneceo-protects-review-not-authorship-ceos-ruling-2026-09-18)).

## Routing — who reads what (chairman, 2026-09-14)

- **`product-manager` is the first reader, and ruler, for rows, the queue and process:** filing and
  amendments, Region and done-when wording, holds, lane labels, promotions, claim reports, merge
  close-outs, host-run announcements. An engineer's report goes there, never to `ceo`.
- **Three things come up to `ceo`:** a ruling `product-manager` cannot make (a rule or ADR conflict, a
  crossing into a `ceo` lane, the publish path); ONE state reading per tick; anything for the chairman.
- **A `needs:chairman` row carries a BRIEF, not a ticket (#3409):** it opens `BRIEF for the chairman`, in plain
  English, and a missing required line sends NO alert. **Before labelling, confirm it is still needed and his
  own Claude session cannot do it** ([lines, why](../../docs/operational-lessons.md#a-needschairman-brief-is-a-brief-not-a-ticket)).
- **That reading is POSTED and DELIVERED (#2083):** post on **#928** (the RECORD), then deliver it with
  **`agent-org prompt:session ceo "…"`**. **Both halves, or it is unrecorded or undelivered.**
- **`orchestrator` is the first reader for fleet and lab questions**; answers are posted on the row.
- **PR n's reviewer is `reviewer-<n>` (#2401):** the gate starts it.
  The author re-prompts a live one after a push: `agent-org prompt:session reviewer-<n> "…"`.
  **Neither does for `awaiting-evidence` PRs (#2416).**
  **`prompt:session` CLEARS A STANDING SEAT, never a `reviewer-<n>` or spawned `worker-<n>` (#2483)**, so
  it re-prompts a reviewer; no raw `herdr … agent prompt`. No verdict in 30 min goes to `product-manager`,
  who re-prompts once, then `ceo`.
- **ONE CALL IS ENOUGH, AND RETRYING IS THE WRONG THING (#1966).** `prompt:session` **queues** the order
  (**exit `2` is `QUEUED`, not a failure**) and the next `work:tick` delivers it. **Do not retry
  and do not poll:** a retry is a second copy, and wipes a standing seat's work. A refusal naming a
  session the org does not know is a typo — NOT queued, and it says so.
- **A REPORT THAT NEEDS NO DECISION IS A ROW WRITE, NOT AN ORDER (#2167).** The comment plus the label
  change IS the completion, the claim report, the close-out — no turn, and read when its reader next
  acts. So `prompt:session` REFUSES a target already holding 10 (55 of 60 queued orders were for one
  session, oldest 8h), naming the depth, the wait and that remedy. `--needs-decision` — a ruling, a
  stop-the-line, an answer that moves somebody — still queues.
- **`ceo` keeps:** the publish order, freeze decisions, reviewer spot-checks, the board edition read,
  rulings arriving through `product-manager`, and the chairman.
