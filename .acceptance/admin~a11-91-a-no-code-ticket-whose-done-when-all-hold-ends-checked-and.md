## What it is

A ticket whose work needs no code (setup, configuration, verification) ends its run `checked` even when every Done-when item holds. No pull request merges, so Linear's GitHub integration never moves the ticket to Done, and it stays open until a person closes it by hand. Seen on A11-88 on 2026-10-18. `checked` also means "nothing to change" with no way to say the ticket is finished, and a worker that finds the ticket's own wording wrong (as with A11-88) can only ask a person to paste a correction.

## Change

A new worker outcome, `done`, with `reason` and `evidence` (one line per Done-when item). `pool.ts` refuses it as `needs-human` when it has no reason or no evidence, when the run is a planning or review run, or when the ticket has open sub-issues. Otherwise the board calls the tracker's `complete` (move to the lowest-position completed-type state, then post the reason and evidence as a comment), clears the run's record of its state move so nothing puts the ticket back, and ends the run Completed. A tracker that refuses, or a team with no completed state, hands the run to a person and leaves the ticket where it is. `checked` is unchanged.

A worker may propose an `edit` (title and/or description, with `why`) on `done`, `checked` or `needs-human`. The board stores it on the run with the ticket's text as the tracker holds it at that moment. `POST /api/queue/<key>/apply-edit` writes it through the new `TicketSource.updateTicketText` only when the ticket still holds that text; `discard-edit` drops it. The worker's brief (`briefText`) says when to write `done` and when `checked`, and describes the edit field. The planning and review briefs are unchanged.

Tests: `src/ticket-mode/pool.test.ts`, `src/ticket-mode/queue.test.ts`, `src/ticket-mode/board-view.test.ts`, `src/ticket-mode/worker-files.test.ts`, `src/ticket-mode/linear.test.ts`, `src/ticket-mode/server.test.ts`, `src/ticket-mode/ui-server.test.ts`, `src/ticket-mode/remote-proxy.test.ts`, `src/ticket-mode/ui.test.ts`.

Refs A11-91

Flag: none -- `done` and `edit` are new outcome fields; no existing outcome changes meaning. `checked` and `needs-human` keep their behaviour when they carry no `edit`.
Health-signals: none
Revert: revert this PR. A `done` outcome then reads as `needs-human` ("could not be read"), and no edit is offered.

Acceptance: `bash -c 'cd /home/agent/repos/.tickets/A11-91/agent-org && pnpm exec rstest run --config scripts/rstest/rstest.config.ts src/ticket-mode/pool.test.ts src/ticket-mode/queue.test.ts src/ticket-mode/board-view.test.ts src/ticket-mode/worker-files.test.ts src/ticket-mode/linear.test.ts src/ticket-mode/server.test.ts src/ticket-mode/ui-server.test.ts src/ticket-mode/remote-proxy.test.ts src/ticket-mode/ui.test.ts'`
