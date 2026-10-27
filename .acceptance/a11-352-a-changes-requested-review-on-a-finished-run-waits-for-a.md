A finished run the board watches (Ready to merge, Published, or a reviewed or ready-pr run awaiting review) whose open pull request reads changes requested at its head for more than 30 minutes with no new push gets the feedback round Respond would start, queued by the board's watch itself, counted as one of its own rounds, and no Needs-you note. The stale-block note is written only when the board cannot start a round (a draft waits for Approve, a run that ended another way waits for Respond, a stand-off whose routes ended), and it says why.

Acceptance:
```bash
npx rstest run --config scripts/rstest/rstest.config.ts src/ticket-mode/board-view/stale-block.test.ts
```

Consumer-declaration: none -- no host file changes meaning. A stale-block note written before this change ends `a person decides` and is still recognised, so the board clears it as before.
