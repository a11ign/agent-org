A queued ticket-mode run with a planned repository starts on top of a blocker that has an open pull request in that repository, instead of waiting for it (`stackedOn`, `waitsOn`, `repoOfPull` and `stackNote` in `src/ticket-mode/board-view.ts`, drawn by `ui.html`; `Blocker.branch` in `source.ts`, read by `blockers` in `linear.ts`). Its brief names each such blocker's pull request and branch, and tells the worker to branch from it and run `gh stack link` (`stackText` and `briefText` in `worker-files.ts`; `prepare` in `pool.ts`). `ticket:worktree <repo> --from <branch>` makes the worktree from that branch (`main` and `makeWorktree` in `worktree-command.ts`; `addWorktree` in `worktree.ts`). The hook allows `gh stack link` and refuses every other `gh stack` command (`BASH_REFUSALS` in `hook.ts`).

Acceptance:
```bash
npx rstest run --config scripts/rstest/rstest.config.ts src/ticket-mode
```

Consumer-declaration: none -- a run with no planned repository waits for its blockers exactly as before; a stacked run's pull request is still a draft, and every `gh stack` command but `link` stays the person's.
