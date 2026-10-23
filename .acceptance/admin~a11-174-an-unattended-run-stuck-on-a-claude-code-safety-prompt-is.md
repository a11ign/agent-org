## What it is

Claude Code asks a person before some commands even with permissions bypassed. On A11-160 a worker ran `rm -f $SC/*.done` and Claude Code asked "Dangerous rm operation on possibly-empty variable path ... Do you want to proceed?". Nobody watches an unattended run's prompts, so the board showed "Waiting on a person" for minutes until the chairman's session cancelled the prompt by hand. The pool now does what the chairman did: it answers No, tells the agent why in one message, and says so on the card (A11-174).

## Change

- `src/pane-dialog-read.ts` (new, a leaf): `readDialog` and its helpers moved out of `src/pane-dialog.ts`, which re-exports them, so ticket mode reads a pane without loading the org's row machinery. `readDialogLines` also gives the question paragraph's lines and the lines above it; `readDialog`'s answer is unchanged.
- `src/ticket-mode/safety-prompt.ts` (new, pure): `readSafetyPrompt` reads a pane as a safety prompt (question starts `Do you want to`, one choice starts `No` and ends `(esc)`; its command and warning), an unrecognised prompt (its first line, cut to 120 characters) or nothing; `declineMessage` is the one message to the agent.
- `src/ticket-mode/pool-decline.ts` (new): `declineSafetyPrompt` sends `agent send-keys <name> esc` (never Enter, never a digit) up to `MAX_SAFETY_DECLINES` = 3 times a run, never on a talk session; `tellDeclined` sends `agent prompt` straight after, and `retellDeclined` sends it on the next pass that finds the agent not blocked when herdr refused it.
- `src/ticket-mode/pool-watch.ts`: `watchRunning` reads the pane after `answerStartDialog` (the start dialogs are still answered Yes first), declines, records the first line of a dialog it leaves, and does not end an idle run as `no-outcome` while its decline is untold.
- `src/ticket-mode/queue/queue-entries-and-outcomes.ts`, `queue-transitions.ts`, `queue-declined.ts` (new), `queue-pins.ts`: `Entry.declined` and `Entry.prompt`; `observe` takes the first line; a finished run drops both, and so does a run requeued for an update.
- `src/ticket-mode/board-view/run-reason.ts`, `view-types-and-filters.ts`, `ui.html`: `promptNote` is the card's line.
- `src/ticket-mode/worker-files.ts`: "Commands that stall an unattended run" in the plan, batch plan, worker, review, publish and writer briefs.
- `src/ticket-mode/pool.ts`, `pool-start.ts`: header comments.
- `src/packaging/project-vocabulary.test.ts`: `"blocked"` in `pool-decline.ts` is declared as herdr's agent status, not a vocabulary label.

## How it is proven

Each acceptance line of the ticket is proven by a named test:

- a running agent on a Claude Code permission or confirmation prompt is answered No (never Yes), told in one message which command was refused and why, and the board says "a safety prompt was declined automatically": `A11-174: a run on the dangerous-rm prompt is answered esc, never enter or a digit, told once which command and to guard it with ${VAR:?}, and recorded as declined, not waiting` (`src/ticket-mode/pool.test.ts`, which also checks the card's line through `promptNote`), `A11-174: a run whose safety prompt was declined shows 'A safety prompt was declined automatically' with its command, and no 'Waiting on a person'` (`src/ticket-mode/ui.test.ts`);
- a prompt the pool does not recognise is left for a person, and the board shows its first line: `A11-174: an unrecognised dialog is not answered: no key and no message are sent, the run is waiting, and its first line is recorded` (`pool.test.ts`), `A11-174: a waiting run shows 'Waiting on a person: <first line>' ...` (`ui.test.ts`);
- the worker brief carries the rule to guard variable paths: `A11-174: every unattended brief says to guard variable paths with ${VAR:?}` (`src/ticket-mode/worker-files.test.ts`);
- a test feeds a pane with the dangerous-rm prompt and checks the No, the message and the board line: the first `pool.test.ts` test above, over the reconstruction of the A11-160 pane in `src/ticket-mode/safety-prompt-fixture.ts`.

The edges: the reader and its negative controls (`src/ticket-mode/safety-prompt.test.ts`); a refused message sent on the next unblocked pass and no `no-outcome` meanwhile, the fourth prompt left waiting, a talk session never declined, a batch run's members all recorded (`pool.test.ts`); the queue's record (`src/ticket-mode/queue.test.ts`); `readDialog` unchanged (`src/pane-dialog.test.ts`).

Acceptance:
```bash
npm run lint
npm run typecheck
npx rstest run --config scripts/rstest/rstest.config.ts src/ticket-mode/safety-prompt.test.ts src/pane-dialog.test.ts src/ticket-mode/pool.test.ts src/ticket-mode/ui.test.ts src/ticket-mode/worker-files.test.ts src/ticket-mode/queue.test.ts src/ticket-mode/board-view.test.ts src/ticket-mode/update-drain.test.ts src/packaging/project-vocabulary.test.ts
```

History: full

`pool.test.ts` imports closures that read `git log` (the host-drift notes), so this run needs the full history the checkout would otherwise lack.

Consumer-declaration: none -- `declined` and `prompt` are optional fields of a queue entry that an older reader ignores, and `readDialog`'s answer is unchanged.
