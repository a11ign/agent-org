## What it is

The ticket board held a queued run back for another run's `.acceptance/` and `.changeset/` files. Every plan lists those directories whole, and the overlap check counted a directory as overlapping every file in it, so any two tickets in one repository waited on each other. Those files are named by ticket (`.acceptance/<branch>.md`, a changeset with a generated name), so no two tickets write the same one. A pull request whose file list GitHub cut short also held its whole repository, although the files past the list are unknown, not untouched.

## Change

- `src/ticket-mode/board-view/settled-by-pulls.ts`: `footprintOf` and `overlapWait` leave out `.acceptance/` and `.changeset/` at the repository root, and the empty name that marks a cut list. `pathsOverlap` loses its whole-repository rule. A new `cutListNote` says which pull request lists only part of its files, and `ui.html` draws it on the queued run's row beside the wait note. Real shared paths, such as `eslint.config.ts`, still hold the run, and the wait note names the path and the ticket holding it.
- `src/ticket-mode/worker-files.ts`: the planner brief says not to list `.acceptance/` or `.changeset/`.
- `src/ticket-mode/pool.ts`: the log line for a cut list says the files past those read are unknown and hold nothing.
- Tests for each line of A11-117's acceptance.

## Acceptance

Two queued tickets in one repository whose plans list the scaffolding directories start together, up to the queue's limit. A ticket sharing a source file still waits, and the board names that file.

Acceptance:
```bash
set -e
node_modules/.bin/rstest run --config scripts/rstest/rstest.config.ts --testNamePattern "A11-117" src/ticket-mode/board-view.test.ts src/ticket-mode/queue.test.ts src/ticket-mode/pool.test.ts src/ticket-mode/worker-files.test.ts
npm run typecheck
```
