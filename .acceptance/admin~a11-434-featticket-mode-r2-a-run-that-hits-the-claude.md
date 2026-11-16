A ticket run whose worker is out of Claude allowance is held as Waiting: allowance with its reset time, instead of being ended `no-outcome` (Failed) or shown as Needs you on Claude Code's limit menu (A11-434, step 1 of 2). The pool reads the worker's transcript for the allowance message, and a `blocked` worker's pane for the limit menu, through `src/ticket-mode/allowance.ts`; the message and its reset are parsed in one leaf, `src/account-limit-message.ts`, which row mode's `wake/exit-and-limits.ts` now reads too. Every captured sample of the message (Claude Code 2.1.296's transcript entry, 2.1.299's pane with the menu, the measured short form) is recognised with its reset.

Acceptance:
```bash
npx rstest run --config scripts/rstest/rstest.config.ts src/account-limit-message.test.ts src/ticket-mode/allowance.test.ts src/packaging/wake-limited-session.test.ts src/account-limit.test.ts
```

Mutation: in `src/ticket-mode/pool-watch.ts`, make `watchAllowance` return `false`, and the AC1 tests fail: the idle worker is ended `no-outcome` and the blocked one reads Needs you.

Consumer-declaration: none -- no host file key or contract changes. The queue file gains an optional `allowance` on a running entry, dropped when the run ends.
