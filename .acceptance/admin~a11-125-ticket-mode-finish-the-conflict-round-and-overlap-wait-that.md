Ticket mode finishes the conflict round and the overlap wait A11-82 left open (A11-125).

- A run handed back at its round cap for a conflict: Respond to review briefs the worker to merge the base in first (never a rebase, never a force-push), keep both changes, re-run the checks, push and reply. A Respond to review round on a pull request that does not conflict keeps its brief.
- A plan's `## Paths` is the one section that the overlap wait and `pr:open` both read; a plan with only the old `## Region` lines is read as before.
- A run that has just finished with an open pull request holds that pull request's files at once, and a run whose files cannot be read holds its repository until a watch reads them.
- A plan that cannot be downloaded holds only its own run, which says why it waits, and the other runs start; overlapping runs still never start together in one pass.
- A run Blocked only on an overlap offers Start anyway, which starts it and records the overlap it passed on its row.

Acceptance:
```bash
set -e
npm run typecheck
npm run lint
P=$(mktemp -d); cp -r src/packaging/fixtures/project-tree/. "$P"; sed -i "s|@@PROJECT@@|$P|" "$P/.agent-org/host.json"; git -C "$P" init -q; git -C "$P" add -A; git -C "$P" -c user.name=ci -c user.email=ci@localhost commit -q -m fixture
A11Y_PRIVATE_TMP_BASE="$(mktemp -d)" AGENT_ORG_HOST="$P/.agent-org/host.json" npx rstest run --config scripts/rstest/rstest.config.ts src/ticket-mode/queue.test.ts src/ticket-mode/worker-files.test.ts src/ticket-mode/overlap.test.ts src/ticket-mode/pr-open-ticket.test.ts src/ticket-mode/pool.test.ts src/ticket-mode/board-view.test.ts src/ticket-mode/server.test.ts src/ticket-mode/ui.test.ts
```
