## What it is

Step 1 of 3 of A11-403. a11ign/agent-org #2017 sat approved, armed, green and BLOCKED because the board reran a cancelled `gate` once, and that rerun cancelled the healthy sibling `ci` run (both runs share one concurrency group). The board now asks the code host whether a run of the cancelled run's workflow is in progress at the head (`runsInProgress`, contract 4.1) and reruns only when none is, one run for each watch. It takes at most two reruns for a head; the third cancelled run stops it, with one `cancelled-rerun` event marked `stopped`, a line in the board's log, and a line on the run's card.

## Acceptance

`src/ticket-mode/pool-cancelled-gate.test.ts` drives the sequence of #2017 through `pool.watchFeedback()` over the fake code host: a rerun, no rerun while a sibling is in progress, a rerun after it finished, then the stop, which the run's log, the board's log and `reasonOf` on the stored run all say. `plugins/github/check-runs.test.ts` holds the GitHub plugin's `runsInProgress` to the run list (`workflow_id` and `status`). The Timeline row of the stop is in `ui/src/run-detail/run-detail-timeline.test.tsx`.

Acceptance:
```bash
set -e
npm run typecheck
P=$(mktemp -d); cp -r src/packaging/fixtures/project-tree/. "$P"; sed -i "s|@@PROJECT@@|$P|" "$P/.agent-org/host.json"; git -C "$P" init -q; git -C "$P" add -A; git -C "$P" -c user.name=ci -c user.email=ci@localhost commit -q -m fixture
AGENT_ORG_HOST="$P/.agent-org/host.json" npm exec -- rstest run --config scripts/rstest/rstest.config.ts src/ticket-mode/pool-cancelled-gate.test.ts plugins/github/check-runs.test.ts plugins/github/sync-gh-guard.test.ts src/plugins/built-in.test.ts src/plugins/cli.test.ts
```

Consumer-declaration: none -- no option is added: `runsInProgress` is an optional operation of the code host contract, which the bundled GitHub plugin implements.
