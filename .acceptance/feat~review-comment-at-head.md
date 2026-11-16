`tickets.reviewComments` names comments a CI review posts (author and body prefix). The GitHub plugin reads the newest matching conversation comment posted or last edited after the head arrived (code host contract 4.2), and the board's card names it as a review at the head, never as an approval: merge gating and readiness stay the reviews' alone.

Acceptance:
```bash
pnpm install --frozen-lockfile && AGENT_ORG_HOST=$HOME/.agent-org/host.json pnpm exec rstest run --config scripts/rstest/rstest.config.ts plugins/github/comment-review.test.ts plugins/github/index.test.ts src/ticket-mode/board-view.test.ts src/ticket-mode/pool-merge-queue.test.ts src/ticket-mode/pool-settle-heads.test.ts src/ticket-mode/read-feedback.test.ts src/ticket-mode/settings.test.ts src/ticket-mode/config-schema.test.ts src/plugins/built-in.test.ts src/plugins/cli.test.ts
```

Consumer-declaration: none -- an optional host key, off unless named; a plugin of contract 4.1 or before is read as naming no review comment.
