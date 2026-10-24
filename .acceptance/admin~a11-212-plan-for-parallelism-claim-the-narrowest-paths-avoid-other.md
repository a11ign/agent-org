A plan claims the narrowest paths, the board refuses a folder another ticket writes in, and the card names what holds a run. Four parts, each proven by a test that runs against this branch:

- **The planner is shown what is held, and asked for the narrowest claim.** Both planning briefs print a "Paths other tickets hold" section from `claimsText` (`src/ticket-mode/path-claims.ts`) and carry the narrowest-path, per-feature, integration-point and steps rules; the batch brief orders a ticket `after` another only for its code or a shared file. The board writes the same array to `claims-given.json` beside the run (`pool-prepare.ts`).
- **A folder claim another ticket writes inside is refused, with narrower paths named.** `folderClaimMisses` is one check with two callers: the planner's Stop hook sends the plan back once (`claimsRetry` in `hook.ts`, marked by `claims-retried.json`), and the board's settle step refuses it as Needs you (`planFiles` in `pool-settle.ts`). A file claim is never refused, and a batch's tickets are checked against each other unless `order.json` orders them.
- **Two plans with per-feature paths run side by side.** Two queued runs in one repository whose plans claim `ui/src/pages/settings/` and `ui/src/pages/tickets/` (and their own test and capture folders) both start in one pass, and neither card has a wait note.
- **The card names the overlapping paths.** A run held for an overlap says "Waits on A11-196: both touch ui/src/shell/App.tsx, ui/test/fixtures.ts", every file both claim, and when every overlap is a directory claim and no file is shared it adds "a folder claim, not a shared file: narrow A11-196's `ui/test/` in its plan" (`overlap-hold.ts`).

Acceptance:
```bash
pnpm exec rstest run --config scripts/rstest/rstest.config.ts src/ticket-mode/path-claims.test.ts src/ticket-mode/hook-claims.test.ts src/ticket-mode/plan-claims-settle.test.ts src/ticket-mode/overlap-hold.test.ts src/ticket-mode/planner-brief-claims.test.ts src/ticket-mode/worker-files.test.ts src/ticket-mode/board-view.test.ts src/ticket-mode/queue.test.ts src/ticket-mode/ui.test.ts
```

After merge (the chairman session): the next batch of sibling Atomaut pages is planned with the held paths in its brief and runs side by side where its files do not overlap. Before merge, `overlap-hold.test.ts` is the runnable check.

Consumer-declaration: none -- `overlap-hold.ts` is the part of `board-view/` the queue and the page already read, and `path-claims.ts` is read by `worker-files.ts`, `hook.ts`, `pool-prepare.ts` and `pool-settle.ts`, which the board's server and the planner's hooks already run.
