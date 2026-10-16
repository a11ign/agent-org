A person approves a ticket-mode run's open pull requests from the board, which queues the ticket again as a review run (`approve`, `retry` and the saved `session` in `src/ticket-mode/queue.ts`; `POST /api/queue/<key>/approve` in `server.ts`). The review run resumes the worker's own Claude session, or the newest one kept for the ticket's folder, and is briefed to mark its pull requests ready and see them through their checks and review (`sessionToResume`, `findFolderSession`, `prepare`, `start` and `settle` in `pool.ts`; `reviewBriefText`, `reviewPrompt` and `workerFlags` in `worker-files.ts`). Only a review run may run `gh pr ready` (`toolVerdict` and the `review-run` mark in `hook.ts`). A reviewed run shows as Ready to merge, and a live one as Reviewing (`runStatus`, `runActions` in `board-view.ts`, drawn by `ui.html`), and `tickets.review` adds the machine's review notes (`settings.ts`).

Acceptance:
```bash
npx rstest run --config scripts/rstest/rstest.config.ts src/ticket-mode
```

Consumer-declaration: none -- an optional host key and a new board action; a draft pull request is approved only by a person pressing Approve, and every other run's refusals are unchanged.
