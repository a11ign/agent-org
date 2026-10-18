## What it is

The Pick view listed only the tickets assigned to the person whose Linear key the board reads with. A ticket filed with no assignee, or with someone else's, never appeared, and the counter said "0 of 65 assigned to you shown" with no way to see the rest. Two tickets filed through the API on 2026-10-18 were invisible until someone assigned them by hand (A11-108).

## Change

- `src/ticket-mode/linear.ts`: the Pick list reads every open ticket the key can see, or every open ticket of the `tickets.pick` team or project, each with `assignee { id name }`. `pickQuery` is one query for all scopes; the team and project are variables, as before. `me()` returns the key's person by id and name (email when Linear has no name); `viewer()` keeps its name-only answer.
- `src/ticket-mode/source.ts`: `Ticket.assignee` (absent when a source does not read assignees, `null` when nobody has the ticket) and the optional `me()` on `TicketSource`.
- `src/ticket-mode/server.ts`: `/api/config` carries `viewer` (the key's person, or `null`), `pickDefault` (`"you"` or `"anyone"`) and `pickOpen` (what Anyone reads as in the count). `viewer` is read once and kept; a failed read is `null` and is asked again on the next config read. `pick` keeps its string.
- `src/ticket-mode/assignee-filter.ts` (new, pure, imports nothing, served as `/assignee-filter.js`): the scopes, the chips and their counts, the default, the counter's words, the empty text, and the owner pill's rule. `PICK_SETTING` is the sentence about `tickets.pick` that the server's and the page's empty text share.
- `src/ticket-mode/pick-scope.ts`: `pickEmptyText` takes `PICK_SETTING` from `assignee-filter.ts`; its sentences are otherwise unchanged.
- `src/ticket-mode/ui-server.ts`: serves `/assignee-filter.js`.
- `src/ticket-mode/ui.html`: the Assignee row beside Projects; the owner pill on every row once the list is not the signed-in person's own, context parents included; the counter names the scope; the empty state names the scope; the Projects, Labels, Priority and Plan counts are over the chosen scope, so the default view counts the signed-in person's own tickets; parents outside the scope with a ticket in it are shown as context, now worded "Not in this view".
- `README.md`: the Pick bullet and the `tickets.pick` row.

## Acceptance

Lint has no errors and typecheck passes. The named tests pass: `--testNamePattern "A11-108"` across the Assignee tests, and the whole of the files they live in, which the ticket-mode suite runs too. The done-when is proven by `ui.test.ts`: "A11-108: the done-when" drives the page's own script against a canned `/api/tickets` and posts `/api/queue` with the unassigned ticket's key.

Acceptance: `bash -c 'set -e; npm run lint; npm run typecheck; P=$(mktemp -d); cp -r src/packaging/fixtures/project-tree/. "$P"; sed -i "s|@@PROJECT@@|$P|" "$P/.agent-org/host.json"; git -C "$P" init -q; git -C "$P" add -A; git -C "$P" -c user.name=ci -c user.email=ci@localhost commit -q -m fixture; AGENT_ORG_HOST="$P/.agent-org/host.json" npm exec -- rstest run --config scripts/rstest/rstest.config.ts src/ticket-mode/assignee-filter.test.ts src/ticket-mode/linear.test.ts src/ticket-mode/server.test.ts src/ticket-mode/ui.test.ts src/ticket-mode/ui-server.test.ts src/ticket-mode/pick-scope.test.ts --testNamePattern "A11-108"; AGENT_ORG_HOST="$P/.agent-org/host.json" npm exec -- rstest run --config scripts/rstest/rstest.config.ts src/ticket-mode/assignee-filter.test.ts src/ticket-mode/linear.test.ts src/ticket-mode/server.test.ts src/ticket-mode/ui.test.ts src/ticket-mode/ui-server.test.ts src/ticket-mode/pick-scope.test.ts'`

Consumer-declaration: none -- `Ticket.assignee` and `TicketSource.me` are optional; `/api/config` gains three fields and keeps `pick`; a remote instance that sends no `viewer` shows the list as it did before.
