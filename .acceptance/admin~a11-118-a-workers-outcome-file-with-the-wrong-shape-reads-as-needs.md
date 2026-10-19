## What it is

A worker that wrote `{ "kind": "ready-pr", "pr": "<url>" }` for `prs: [{ repo, url }]` ended its turn with a correct pull request. The pool recorded `needs-human: the worker's outcome file could not be read: <first 200 characters>`, which named no field, so the board showed the ticket as Needs you for hours with nothing asked (A11-31, a11ign/control#119).

## Change

- `src/ticket-mode/outcome.ts` (new): `checkOutcome` is the one validator for an outcome file. The Stop hook and the pool both use it, so they cannot disagree. A refusal names the field the contract wants and what the file wrote in its place. `pr` as a GitHub pull request address is accepted by the pool as one pull request and refused by the hook. `OUTCOME_EXAMPLES` holds one concrete example per kind, which the worker briefs render.
- `src/ticket-mode/hook.ts`: `stopVerdict` checks the outcome file on every stop, and refuses one that does not pass, with the problem as its reason, up to the shared count.
- `src/ticket-mode/pool-outcome.ts`: `parseOutcome` is a thin wrapper over `checkOutcome`. An unreadable file is `needs-human` with `unreadable` set and the field named.
- `src/ticket-mode/pool-watch.ts`: `rereadUnreadable` reads a finished run's unreadable outcome again when its file changes, so a corrected file ends the run on its real outcome.
- `src/ticket-mode/worker-files.ts`: the planning, batch-planning, ticket, review and publish briefs show a concrete example of each outcome kind they may write, not placeholders.
- `src/ticket-mode/queue/declared-remains.ts`: `needs-human` gains an optional `unreadable`.
- README: two sentences in "Parked, not closed".

## Acceptance

`bash -c` below: the hook refuses `pr` for `prs` and names `prs`, a corrected file passes, and the four ticket-mode test files pass against a copy of the fixture project, as CI runs them.

Acceptance: `bash -c 'set -e
P=$(mktemp -d); cp -r src/packaging/fixtures/project-tree/. "$P"; sed -i "s|@@PROJECT@@|$P|" "$P/.agent-org/host.json"; git -C "$P" init -q; git -C "$P" add -A; git -C "$P" -c user.name=ci -c user.email=ci@localhost commit -q -m fixture
D=$(mktemp -d)
echo "{\"kind\":\"ready-pr\",\"pr\":\"https://github.com/a11ign/control/pull/119\",\"reason\":\"x\"}" > "$D/outcome.json"
if echo "{}" | node src/ticket-mode/hook.ts stop "$D" 2> "$D/err"; then echo "the wrong shape was allowed"; exit 1; fi
grep -q "ready-pr needs prs: \[{repo, url}\], you wrote pr" "$D/err"
echo "{\"kind\":\"ready-pr\",\"prs\":[{\"repo\":\"a11ign/control\",\"url\":\"https://github.com/a11ign/control/pull/119\"}],\"reason\":\"x\"}" > "$D/outcome.json"
echo "{}" | node src/ticket-mode/hook.ts stop "$D"
rm -rf "$D"
AGENT_ORG_HOST="$P/.agent-org/host.json" npm exec -- rstest run --config scripts/rstest/rstest.config.ts src/ticket-mode/outcome.test.ts src/ticket-mode/hook.test.ts src/ticket-mode/pool.test.ts src/ticket-mode/worker-files.test.ts
'`
