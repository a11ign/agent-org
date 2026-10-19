## What it is

The Pick tab has a project sidebar beside the list, in place of the Projects chip row. It names each project the list holds with its open-ticket count, and shows one project at a time: the project the person chose and that the list still holds, else the first one in the sidebar (most tickets first, then by name). The Assignee, Priority, Plan and Goal filters, and the counter's "of M", count that project's tickets only.

## Change

- `src/ticket-mode/ui.html`: the sidebar (`nav#projects`) in the Pick section's `.runs` layout, which the Board tab's run filters use, with the other filter rows and the list in its right-hand column; every filter, the search, Select all shown and the counter read the chosen project; the choice is remembered in `ticket-mode.project`, and only a click saves it.
- `src/ticket-mode/board-view/view-ticket.ts`: `chosenProject` and `inProject`; `priorityCounts` keeps a chosen priority at 0.
- `src/ticket-mode/label-filters.ts`: a chosen label the wider list holds keeps its chip and row at 0.
- `src/ticket-mode/assignee-filter.ts`: the chosen person keeps their Assignee chip at 0.

## Acceptance

The changed test files pass against a fixture host declaration. The layout test in `ui-css.test.ts` measures the sidebar in headless Chrome, so it runs where Chrome is installed and is skipped otherwise.

Acceptance:
```bash
set -e
npm run typecheck
P=$(mktemp -d); cp -r src/packaging/fixtures/project-tree/. "$P"; sed -i "s|@@PROJECT@@|$P|" "$P/.agent-org/host.json"; git -C "$P" init -q; git -C "$P" add -A; git -C "$P" -c user.name=ci -c user.email=ci@localhost commit -q -m fixture
AGENT_ORG_HOST="$P/.agent-org/host.json" npm exec -- rstest run --config scripts/rstest/rstest.config.ts src/ticket-mode/ui.test.ts src/ticket-mode/ui-css.test.ts src/ticket-mode/ui-server.test.ts src/ticket-mode/board-view.test.ts src/ticket-mode/label-filters.test.ts src/ticket-mode/assignee-filter.test.ts
```
