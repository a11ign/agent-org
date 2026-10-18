## What it is

Pairing a new device for the worker terminal (herdr web ui, `:9444`) needed a hand-run plugin script. With the board served on the tailnet (`tickets.serve`), the terminal asks each new device for its own pairing code, separate from the board's `ticket:pair`, and the only way to get that code was `bun <plugin>/scripts/plugin.ts pair` with the terminal service's environment. On 2026-10-18 the chairman's first worker link asked for one, and the session had to dig the command out.

## Change

`agent-org ticket:pair` prints the board's code and, when the terminal is served for this instance, the terminal's too. The terminal's code is the plugin's own `pair`, run under the terminal service's environment (`terminalPairProgram` in `src/install/terminal.ts`, which the service and the command both build from, so they cannot drift). `--terminal` and `--board` print one of the two.

A paired browser that follows a run's "Open terminal" link goes through the page's service (`/c/<connection>/terminal?link=`), which checks the link is that connection's own terminal address, asks the instance for a terminal code (`src/ticket-mode/terminal-pair.ts`), and redirects to the link with `pair=<code>`. A failed mint redirects to the plain link.

`onboard`'s final message, `doctor`'s `pairing` check and the README say how to pair a new device for both.

Tests: `src/ticket-mode/pair-command.test.ts`, `src/install/terminal.test.ts`, `src/ticket-mode/terminal-pair.test.ts`, `src/ticket-mode/ui-server.test.ts`, `src/ticket-mode/server.test.ts`, `src/ticket-mode/remote-proxy.test.ts`, `src/ticket-mode/board-view.test.ts`, `src/ticket-mode/ui.test.ts`, `src/install/onboard.test.ts`, `src/install/doctor.test.ts`.

Refs A11-93

Flag: none -- `ticket:pair --terminal` and the worker link are new commands and a new route; no behaviour of an existing command changes except the "Open terminal" address, which now goes through the page's service and falls back to the plain address.
Health-signals: none
Revert: revert this PR. `ticket:pair` prints the board's code alone, and "Open terminal" links straight to the terminal again.

Acceptance: `bash -c 'cd /home/agent/repos/.tickets/A11-93/agent-org && pnpm exec rstest run --config scripts/rstest/rstest.config.ts src/ticket-mode/pair-command.test.ts src/install/terminal.test.ts src/ticket-mode/terminal-pair.test.ts src/ticket-mode/ui-server.test.ts src/ticket-mode/server.test.ts src/ticket-mode/remote-proxy.test.ts src/ticket-mode/board-view.test.ts src/ticket-mode/ui.test.ts src/install/onboard.test.ts src/install/doctor.test.ts'`
