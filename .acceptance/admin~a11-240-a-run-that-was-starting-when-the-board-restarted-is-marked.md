A restart of the ticket instance asks herdr whether each live run survived, whatever phase the queue file holds it in (`reconcile` in `src/ticket-mode/pool-readopt.ts`): a run caught `starting`, with no workspace on record yet, is found by its herdr name and adopted (marked running in the workspace herdr lists, its pane sent nothing); a run whose pane is gone ends `crashed: lost in a restart` and is queued again once when the board has no pull request on record for it (`loseInRestart`, `src/ticket-mode/queue/queue-readopt.ts`); a run already marked crashed whose pane herdr lists `working` is taken back on the next watch pass (`readoptCrashed`); and the card says each (`readoptNote`, `src/ticket-mode/board-view/readopt-note.ts`).

Acceptance:
```bash
npx rstest run --config scripts/rstest/rstest.config.ts src/ticket-mode/pool-readopt.test.ts src/ticket-mode/pool.test.ts
```
