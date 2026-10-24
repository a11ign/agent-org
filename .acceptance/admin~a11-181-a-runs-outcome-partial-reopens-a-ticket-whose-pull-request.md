## What it is

A run's outcome carried `partial` set to a list of what was DONE, while its pull request said `Closes A11-155` and delivered the whole ticket. The board trusted the outcome, put the ticket back after Linear's integration closed it, and asked a person to dismiss and re-queue a ticket with nothing left to do (A11-181). Now the merged pull request's own declaration decides.

## Change

- `src/ticket-mode/ticket-references.ts`: `declarationOf(body, key, keywords)` reads a body's declaration with the grammar `pr:open` and CI already share: a `Partial:` line (whatever closing words the body carries), else a closing line naming the key, else nothing.
- `src/ticket-mode/queue/queue-declarations.ts` (new, pure): which runs are read, how several merged bodies combine (`declare`), and what the declaration does to the run's `partial` and the disagreement it records (`recordDeclared`).
- `src/ticket-mode/pool-pull-declarations.ts` (new): reads each merged pull request's body through the code host's `readMergedFindings`, once per run, in `refreshTracker` before anything acts on the merge. A read that cannot answer is asked again on the next sweep.
- `src/ticket-mode/board-view/pull-settled.ts`, `queue/queue-next-step.ts`: a run whose outcome has a `partial` is neither put back nor queued a next step until its merged bodies are read.
- `src/ticket-mode/board-view/run-reason.ts`: the card names the disagreement (the outcome's words and the pull request's declaration) and says when it is reading.
- `src/ticket-mode/board-view/plan-steps.ts`: a merged `Partial:` the plan has no numbered step for says to close the ticket and file what remains.
- `src/ticket-mode/worker-files.ts`, `README.md`: the brief says `partial` names what is still owed, never what was done, and is absent when the body says `Closes`.

## Acceptance

Lint has no errors and typecheck passes. The named tests pass: `src/ticket-mode/pull-declaration.test.ts` proves the three cases of the ticket's Acceptance (`Closes` + outcome `partial` completes and the card shows the disagreement; `Refs` + `Partial:` keeps it open; `Closes` alone completes), the sibling convention, and the reads that cannot answer. The other test files hold the grammar (`pr-open-ticket.test.ts`), the brief (`worker-files.test.ts`) and the existing partial-merge tests, which now seed the merged bodies they act on.

Acceptance: `bash -c 'set -e; npm run lint; npm run typecheck; P=$(mktemp -d); cp -r src/packaging/fixtures/project-tree/. "$P"; sed -i "s|@@PROJECT@@|$P|" "$P/.agent-org/host.json"; git -C "$P" init -q; git -C "$P" add -A; git -C "$P" -c user.name=ci -c user.email=ci@localhost commit -q -m fixture; AGENT_ORG_HOST="$P/.agent-org/host.json" npm exec -- rstest run --config scripts/rstest/rstest.config.ts src/ticket-mode/pull-declaration.test.ts src/ticket-mode/partial-merge-reopen.test.ts src/ticket-mode/pr-open-ticket.test.ts src/ticket-mode/worker-files.test.ts src/ticket-mode/plan-steps.test.ts src/ticket-mode/queue.test.ts src/ticket-mode/board-view.test.ts src/ticket-mode/pool.test.ts'`

Consumer-declaration: none -- no contract changes: the board reads a merged body through the code-host contract's existing optional `readMergedFindings` (1.4), and `Entry`/`ViewEntry` gain optional fields.
