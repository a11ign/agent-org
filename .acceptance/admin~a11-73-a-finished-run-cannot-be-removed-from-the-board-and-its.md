A finished run can be dismissed from the ticket board, and closes its workspace. A `needs-human` run closes its workspace once its outcome is recorded, and Retry resumes its recorded session with the reason it gave. `wrong-repo` and a run with no outcome still park. A run whose ticket is closed in Linear or is now a parent of sub-issues is offered Dismiss with the reason (`dismissNote`, `trackerParent`, `parentKeys` in `linear.ts`). Changed: `queue.ts` (`dismiss`, `retry`, `recordTrackerParents`), `pool.ts` (`dismiss`, `end`, `prepare`, `start`, `refreshTracker`), `board-view.ts` (`PARKS`, `dismissNote`, `runActions`), `worker-files.ts` (`resumePrompt`), `server.ts`, `remote-proxy.ts`, `ui.html`, `source.ts`, `linear.ts`.

Acceptance:
```bash
npx rstest run --config scripts/rstest/rstest.config.ts src/ticket-mode
```

Mutation: (each applied to a copy of the change, the suite run on that copy, then discarded) dropping the workspace close in `end()` failed 5 of 142 in `pool.test.ts` and `queue.test.ts`, including `a run that hands its ticket back as needs-human closes its workspace once the outcome is recorded, keeping its session`; dropping the refusal for a running run in `pool.dismiss` failed 2 (`Dismiss is refused for a running run, which keeps its workspace open` and the queued/starting/unknown-key refusal); dropping `resumes` from `retry` failed 3 (the two Retry-resume tests and the queue test); dropping the workspace close from `pool.dismiss` for a parked run failed 2 (the parked-run dismiss and the batch-member dismiss).

Base: the same new tests were run against the base commit's source (`c9f7934e`) with this change's tests. 29 of 471 failed there, all of them new or deliberately changed expectations (new Dismiss, resume, parent and route tests, the brief sentences, the refused-close log, and existing action lists that now end in `dismiss`). The tests that pin behaviour kept from the base pass there too: `wrong-repo` and no-outcome parking, Close on a parked run, a draft closing its workspace, and the batch's hand-back.

Consumer-declaration: none -- `parentKeys` is optional on a ticket source, and a source without it never marks a ticket a parent.
