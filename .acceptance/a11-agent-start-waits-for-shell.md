A ticket run's agent start is tried again, in the same workspace, while herdr refuses it with `agent_pane_busy` because the new pane's shell is not at its prompt yet: every 500 ms, up to 30 tries. Any other refusal fails the start at once, and a pane that never comes up fails the run as before, with its workspace closed.

Acceptance:
```bash
A11Y_PRIVATE_TMP_BASE=/tmp/ao-private-tmp npx rstest run --config scripts/rstest/rstest.config.ts src/ticket-mode/pool.test.ts
```

Mutation: the retry condition was made to always throw, and then the try limit was cut to one. Each time two tests went red (a start that succeeds after three refusals, and one that fails only after 30), and both were restored and the suite passed again.

Consumer-declaration: none -- `paneShellNotReady` and the retry are used only by the pool's `startAgent`, and a start that succeeds on the first try behaves as before.
