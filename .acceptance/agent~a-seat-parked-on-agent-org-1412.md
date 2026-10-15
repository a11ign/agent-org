A seat parked on the Claude limit menu (its pane offers "Stop and wait for limit to reset" and "Switch to usage credits") is freed once the reset in its transcript has passed. `freeLimitMenuSeats` (`src/wake.ts`) runs in the tick right after `accountPauseTick`, and only when that returns no pause. For each `blocked` seat whose pane is the limit menu (`isLimitMenu`, `src/worker-state.ts`, pure: both phrases must be there) and whose last transcript reply is a limit message whose reset has passed, it sends exactly `esc` (`herdr --session org agent send-keys <label> esc`). Enter, digits and any other key are never sent by this path. A seat whose reset is still ahead, or whose pane is some other question, is left alone. A refused `esc` frees nothing and is not said. The whole path is off with `gate.accountLimitPause` (the #1307 flag), so the revert is the same switch.

`tellBlocked` (`src/worker-state.ts`) does not tell a limit-menu seat the declare-or-decide text, and does not record it as told, so a menu seat is not repeated in `agent_blocked` in a tick. A non-menu blocked worker is still told once.

The tick says ONE line when it frees one or more seats: `freed N seats from the limit menu: <labels>`. Nothing is said for a menu seat before its reset.

Acceptance: `node --test src/account-limit.test.ts` (26 tests). The control is the menu seat with a past reset: exactly one `send-keys worker-1 esc`, and one line said. The other cases pin nothing sent for a future reset, for another question, for a working seat, for a seat answered since the limit, for the flag OFF or an unreadable pane, and for a refused `esc`. Two `tellBlocked` cases pin that a menu seat is never told and never untold across two ticks, and that a non-menu blocked worker is still told once.

Mutation: each change is made to one source file by one edit, the test file is re-run, and the file is restored by Edit and re-run to pass.
- the reset check inverted (`until > now`): 2 tests fail (the control, and the reset-not-come test).
- the menu skip removed from `tellBlocked`: the control `tellBlocked` test fails.
- the `isLimitMenu` check removed from `freeLimitMenuSeats`: the other-question test and the flag-OFF / unreadable-pane test fail.

Positive control: the new test file run against `git archive HEAD` (main at the base of this branch) fails at load, `The requested module './wake.ts' does not provide an export named 'freeLimitMenuSeats'`. That is a load failure, not a behavioural one; the behavioural failures are the three mutations above.

Not verified here, and named: the menu wording is taken from the row's quote, not from a captured pane, so `isLimitMenu` has not been checked against a real limit menu. The reset time is read from the transcript's limit message, because the pane carries no timestamp; that is the assumption. The tick itself was not run end-to-end (the fleet, lab and worker commands are out of bounds for this seat), so the call site in `main()` is checked by typecheck and by reading. `tellBlocked` reads each blocked seat's pane once per tick by default, one herdr process per blocked seat. `src/pane-dialog.ts` (outside this row's Region, not changed) may also raise the limit menu as a pane dialog; that overlap is not analysed. The repository has no `lint` script, so no lint was run. The full `pnpm test` run has 112 failing tests of 11601, and the same tests fail on the base copy (124 of 11568 there); the worktree's failing set is a subset of the base's, so nothing new fails.

Closes a11ign/agent-org#1412

platform: linux, Node v24.21.0; the tests read a fixture home and fixture state directories, and herdr is a fake seat (no live fleet is read).

🤖 Generated with [Claude Code](https://claude.com/claude-code)
