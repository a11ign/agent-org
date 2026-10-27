A pull request's recorded review at a head is what the reviews at that commit say, and no longer what GitHub's review decision still says of an earlier commit: a head nobody reviewed reads `none`, logs no verdict and is never flagged as sat changes requested. A head pushed after changes were requested gets its reviewer once its checks settle green, also when a cancelled duplicate run of one of its checks sits beside the passing run.

Acceptance:
```bash
npx rstest run --config scripts/rstest/rstest.config.ts src/ticket-mode/pool-settle-heads.test.ts src/ticket-mode/board-view/stale-block.test.ts src/ticket-mode/reviewer-port.test.ts src/ticket-mode/pool.test.ts
```

Consumer-declaration: none -- no host file changes meaning.
