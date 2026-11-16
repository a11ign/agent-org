`mergeBaseIn` (`src/ticket-mode/stack-rebase.ts`) fast-forwards the run's worktree to its own branch on the remote before merging a blocker's moved branch in, so a branch someone else pushed to is merged on its current head instead of being refused on every sweep (#2059). A worktree with its own unpushed commit is left as it is, and its push is still refused.

Acceptance:
```bash
pnpm install --frozen-lockfile && AGENT_ORG_HOST=$HOME/.agent-org/host.json pnpm exec rstest run --config scripts/rstest/rstest.config.ts src/ticket-mode/stack-rebase.test.ts src/ticket-mode/pool-tracker
```

Consumer-declaration: none -- the board's own stack merge; no interface changes.
