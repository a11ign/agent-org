Closes A11-240

Step 2 of 2: a run that is queued again, and Respond, find the ticket's pull requests on the code host. The code host contract is 1.18 with one optional read, `pullsNaming(key, repositories)` (the GitHub plugin answers it with `gh search prs`; `null` is "could not ask"). The brief of a work run lists the pull requests whose `Closes` or `Refs` line names the ticket, with the head, failing checks and `Partial:` step of an open one (`src/ticket-mode/opened-pulls.ts`), and Respond on a run whose record holds no open pull request queues a round on an open one the code host holds (`respond` in `src/ticket-mode/queue/queue-transitions.ts`).

A restart of the ticket instance asks herdr whether each live run survived, whatever phase the queue file holds it in (`reconcile` in `src/ticket-mode/pool-readopt.ts`): a run caught `starting`, with no workspace on record yet, is found by its herdr name and adopted (marked running in the workspace herdr lists, its pane sent nothing); a run whose pane is gone ends `crashed: lost in a restart` and is queued again once when the board has no pull request on record for it (`loseInRestart`, `src/ticket-mode/queue/queue-readopt.ts`); a run already marked crashed whose pane herdr lists `working` is taken back on the next watch pass (`readoptCrashed`); and the card says each (`readoptNote`, `src/ticket-mode/board-view/readopt-note.ts`).

Acceptance:
```bash
node --test plugins/github/ticket-pulls.test.ts
npx rstest run --config scripts/rstest/rstest.config.ts src/ticket-mode/pool-readopt.test.ts src/ticket-mode/pool.test.ts src/ticket-mode/opened-pulls.test.ts src/plugins/fakes/code-host.test.ts plugins/github/conformance.test.ts
```
