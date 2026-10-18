## What it is

`clean-code/limited-public-api` (G8) flags a module that exports more than 50 members. It was not on in `eslint.config.ts`. This change turns it on at `error`. Twenty modules were over the limit. Seven now get under it by removing `export` from names that no other file imports, and one dead exported function is deleted. The other thirteen keep their surface, each with a file-level `eslint-disable` and a reason, because their exports are real and splitting them is a separate change.

## Change

- `eslint.config.ts`: `"clean-code/limited-public-api": "error"` with a one-line reason, added to the `adopted` object.
- Seven modules (`src/ci-failure-class.ts`, `src/engineer-route.ts`, `src/gh-ledger.ts`, `src/ready-label-audit.ts`, `src/row-claim.ts`, `src/trace/store.ts`, `src/trace/trace.ts`): `export` removed from names no file outside the module references. `src/ci-failure-class.ts` also loses `refusedRefreshes`, an exported function nothing calls. `src/ready-label-audit.ts` keeps `readRowFilingDoc` exported, because a test reaches it through a dynamic import in a string.
- Thirteen modules (`src/acceptance-commands.ts`, `src/claim-stall.ts`, `src/host-units.ts`, `src/org-health.ts`, `src/org-retro.ts`, `src/row-file.ts`, `src/ticket-mode/board-view.ts`, `src/ticket-mode/queue.ts`, `src/wake.ts`, `src/work-gate.ts`, `src/work-gate/pr-orders.ts`, `src/work-gate/reads.ts`, `src/work-gate/tick.ts`): a file-level `/* eslint-disable clean-code/limited-public-api -- ... */` with the reason. No code changes.

No runtime behaviour changes: the removed `export`s and the deleted function have no caller, and typecheck and the tests show the same results as the base.

## Acceptance

`npm run lint` exits 0 with the rule at `error` and reports no hit for it. `npm run typecheck` passes. The narrow rstest run below covers the tests of the changed modules, including the one that reaches `readRowFilingDoc` by a string-built import.

Acceptance: `bash -c 'set -e; npm run lint; npm run typecheck; P=$(mktemp -d); cp -r src/packaging/fixtures/project-tree/. "$P"; sed -i "s|@@PROJECT@@|$P|" "$P/.agent-org/host.json"; git -C "$P" init -q; git -C "$P" add -A; git -C "$P" -c user.name=ci -c user.email=ci@localhost commit -q -m fixture; AGENT_ORG_HOST="$P/.agent-org/host.json" npm exec -- rstest run --config scripts/rstest/rstest.config.ts src/ready-label-audit.test.ts src/ci-failure-class.test.ts src/engineer-route.test.ts src/gh-ledger.test.ts src/row-claim.test.ts src/trace/trace.test.ts src/packaging/modules-find-the-project.test.ts src/packaging/trace-store-readers.test.ts src/packaging/trace-store-compact.test.ts'`
