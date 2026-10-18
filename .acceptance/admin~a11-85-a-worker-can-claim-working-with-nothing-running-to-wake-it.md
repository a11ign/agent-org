## What it is

A worker could write `{"kind":"working"}` and end its turn with nothing that would wake it. On 2026-10-17 A11-31 started `pnpm fleet:patch` detached and wrote "a watch is armed for its end", with no background shell and no Monitor. The stop hook let `working` through whatever the session was doing, and the board waited thirty minutes before it flagged the run as stalled, and then only flagged it.

## Change

The stop hook lets `working` through only while the session's transcript (`transcript_path` in the Stop payload) shows a background shell or a Monitor still live. With none it refuses: `nothing is running that will wake you; wait in the foreground or arm a Monitor on the process (its PID or its log)`. A transcript it cannot read lets `working` through, out loud. The board reads the pane's status line (`· 1 shell, 1 monitor`): a run idle with no background work for three minutes is marked stalled `background work gone` and told once, `your background work is gone; check it and carry on`. A pane it cannot read leaves the thirty-minute rule to decide. The worker brief says to arm a Monitor on a detached process's PID or log before writing `working`.

Refs A11-85

Flag: none -- the hook and the board read only what a ticket-mode worker's own session writes; no other run writes `working`.
Revert: revert this PR; the stop hook goes back to letting `working` through unchecked, and the board back to the thirty-minute rule.

Acceptance: `bash -c 'cd /home/agent/repos/.tickets/A11-85/agent-org && A11Y_PRIVATE_TMP_BASE="$PWD/node_modules/.cache/a11ign-tmp" npx rstest run --config scripts/rstest/rstest.config.ts src/ticket-mode/background-work.test.ts src/ticket-mode/hook.test.ts src/ticket-mode/queue.test.ts src/ticket-mode/pool.test.ts src/ticket-mode/worker-files.test.ts src/ticket-mode/board-view.test.ts src/ticket-mode/ui.test.ts'`
