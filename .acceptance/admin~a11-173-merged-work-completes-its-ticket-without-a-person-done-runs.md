## What it is

Four tickets sat in "Needs you" on 2026-10-23 with nothing for a person to do: A11-150 (a review round's `done` on a merged pull request), A11-156 (two merged pull requests that both said `Refs`), A11-145 (an after-merge check owned by the chairman) and A11-160 (a `Partial` line with no step number on a nine-step plan). This change settles each without a person.

## Change

- `src/ticket-mode/pool-settle.ts`: a review round's `done` is no longer refused. It is judged by the round's pull requests as the tracker reads them: every one merged or closed with one merged completes the ticket now (the states are recorded, so the card reads them); one still open ends the round as `reviewed` and clears `partial`; all closed unmerged hands the run to a person. `queue/queue-transitions.ts`: a `done` outcome drops `partial` (`checked`, `reviewed` and a crash keep it). `queue/queue-next-step.ts`: `clearPartial`.
- `src/ticket-mode/done-when.ts`: `afterMergeLines(description)` reads the After-merge lines of the Done-when and who runs each. `queue/queue-after-merge.ts`: `afterMergeDue`, `recordAfterMerge`. `pool-tracker.ts`: `noteAfterMerge` records them on the run and posts one comment, after `completeMerged`. `plugins/contracts/tracker.ts` (contract 1.4), `fakes/tracker.ts`, `conformance/tracker.ts`, `plugins/linear/linear.ts`: the optional `comment`.
- `board-view.ts`, `ui.html`: the "After-merge checks" section beside "Pull requests". `board-view/run-reason.ts`: `completed: <PRs> merged`, with `; <n> after-merge checks listed`.
- `src/ticket-mode/plan-step-count.ts`, `pool-plan-steps.ts`, `board-view/plan-steps.ts`, `queue/queue-next-step.ts`, `pool-tracker.ts`: a `Partial` with no `of <M>`, or no step, is counted by the board against the run's record or the plan file's numbered steps, and the next step is queued; the log, the card and the next step's brief say the board counted it. Only a plan with no remaining step stops.
- `src/ticket-mode/worker-files.ts`, `src/install/house-notes.ts`: the brief says `partial` is build work a later run does, never an After-merge line, and that pull requests finishing a ticket together each say `Refs` with no `partial`.

## How it is proven

- a run whose pull requests merged and whose worker says nothing remains completes its ticket, whether the PR said `Closes` or `Refs`, and the card says `completed: <PRs> merged`: `A11-173: a review round's done on merged pull requests completes the ticket and the run reads Completed`, `A11-173: a review round's done with a pull request still open is recorded as reviewed, and the ticket completes when it merges`, `A11-173: two pull requests in two repositories that both say Refs, with no partial, complete the ticket once both have merged, not after the first` (`src/ticket-mode/pool.test.ts`), `A11-173: a done outcome clears the run's partial; checked and reviewed keep it` (`queue.test.ts`), `A11-173: a Completed run's line says completed: a11ign/agent-org #1815, a11ign/plugin #9 merged` (`board-view.test.ts`);
- After-merge lines are copied into a comment and listed with their owner, and such a run is Completed: `A11-173: afterMergeLines reads each After-merge line and who runs it ...` (`done-when.test.ts`), `A11-173: a merged run whose ticket has After-merge lines completes, posts them once as a comment and records them, on Closes and on Refs` (`pool.test.ts`), `A11-173: a Completed run whose pull requests merged is due its After-merge lines once ...` (`queue.test.ts`), `A11-173: the After-merge checks list names each line's ticket and owner ...` (`board-view.test.ts`), `A11-173: the After-merge checks section renders one row per line ...` (`ui.test.ts`), `A11-173: comment posts one comment on a ticket in any state ...` (`src/plugins/fakes/tracker.test.ts`, and the conformance suite's `comment` check), `A11-173: comment() posts the body through commentCreate ...` (`plugins/linear/linear.test.ts`);
- a `Partial` with no step number queues the next step and says so, and only a plan with no remaining step stops: `A11-173: a plan's steps are counted from Step headings ...` (`plan-step-count.test.ts`), `A11-173: a declaration naming step N without of M, or no step at all, takes the plan's size ...` (`plan-steps.test.ts`), `A11-173: step 2 of a nine-step plan merges as Partial: step 2 of the plan, and step 3 is queued and briefed, saying the board counted it`, `A11-173: an unnumbered Partial on a plan with no numbered steps, or on its last step, still stops, with its reason` (`pool.test.ts`), `A11-173: a counted step's brief says the board counted it and asks for step N of M` (`worker-files.test.ts`);
- re-queueing needs no move in the tracker: `A11-173: the next step after an unnumbered Partial starts with no dismissal and no state move in the tracker` (`pool.test.ts`), `A11-173: a stopped partial run on a plan with no remaining step is dismissed and its In Progress ticket, claimed by this instance, is queued again with no state move` (`server.test.ts`);
- the worker's brief: `A11-173: rule 6 and the outcome section say partial is build work a later run does ...` (`worker-files.test.ts`), `A11-173: the opening-a-pull-request line says a partial is a plan step ...` (`src/install/house-notes.test.ts`).

Acceptance:
```bash
npm run lint
npm run typecheck
npx rstest run --config scripts/rstest/rstest.config.ts src/ticket-mode/done-when.test.ts src/ticket-mode/plan-step-count.test.ts src/ticket-mode/plan-steps.test.ts src/ticket-mode/queue.test.ts src/ticket-mode/pool.test.ts src/ticket-mode/board-view.test.ts src/ticket-mode/ui.test.ts src/ticket-mode/server.test.ts src/ticket-mode/worker-files.test.ts src/install/house-notes.test.ts src/plugins/fakes/tracker.test.ts plugins/linear/linear.test.ts
```

History: full

`pool.test.ts` and `doctor.test.ts` import closures that read `git log` (the host-drift notes), so this run needs the full history the checkout would otherwise lack.

Consumer-declaration: none -- the tracker contract goes from 1.3 to 1.4 by the optional `comment`, which a 1.3 tracker lacks and the board then skips (the checks stay on the board, and the log says the comment was not posted); a queue stored before this change reads as before (`afterMerge` and `planSteps` are absent until recorded).
