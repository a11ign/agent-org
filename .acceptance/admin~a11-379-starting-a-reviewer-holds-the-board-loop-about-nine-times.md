Step 1 of 2 of A11-379: the async forms the reviewer port will call. `herdrRunAsync`, `readAgentsAsync`, `openPaneAsync` and `closedNoteAsync` (`src/herdr-agents.ts`) and the gate's checkout, removal, uncommitted-paths, spawn, close, token mint and verdict-door steps (`src/wake/reviewer-start-async.ts`) run their programs through `realExecAsync`, so the event loop goes on while they run. Each answers as its synchronous form does, with the same program calls in the same order, which the parity tests hold. Nothing calls them yet, so no behaviour changes; the synchronous forms (row mode's) are refactored to share their pure parts with the new ones (A11-379).

Acceptance:
```bash
npx rstest run --config scripts/rstest/rstest.config.ts src/herdr-agents.test.ts src/wake/reviewer-start-async.test.ts src/herdr-agents-paneless.test.ts src/herdr-agents-session.test.ts src/wake-herdr-stderr.test.ts src/wake-reviewer-instance.test.ts src/session-tmp.test.ts
```

Consumer-declaration: none -- no host file key changes meaning.
