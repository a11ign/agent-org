`duplicateOf` in the board-truth audit no longer raises the row of record as the duplicate. It took a twin when `other.state === "CLOSED" || other.number < row.number`, so an open row with a CLOSED row filed AFTER it was asked to resolve a pair that was already resolved. A twin now counts only when its number is lower than the row's, open or closed. Seen live: #4623 (open, hand-reroute class row) against the closed #4624 (owner-unresolved, same title template) produced a `board-disagrees-with-reality` order to `product-manager` that sat deferred ("is working") for 30+ ticks, which is what the `1 order(s) had nowhere to go` repeating line was.

Acceptance:

```bash
npx rstest run --config scripts/rstest/rstest.config.ts --include src/board-truth-audit.test.ts
```

Closes a11ign/agent-org#507

Measured: test (6) gains the closed-later-twin negative and its control (the same pair with the closed twin first is still found). The seeded BOARD's closed twin moved from #51 to #9 so it stays filed before open #14 (the emptiness control needs the duplicate question to fire). Locally the file is 43 of 45 with or without this change: two tests that assert `--repo a/b` on `gh` argv fail on untouched main here, so they are not this change.

platform: n/a (audit reader)

🤖 Generated with [Claude Code](https://claude.com/claude-code)
