## What it is

`clean-code/names-describe-side-effects` (N7) flags a `get`, `is`, `has` or `find` function whose body mutates state. It was not on in `eslint.config.ts`. This change turns it on at `error`. Its two hits are both test fakes whose names are fixed by an interface outside the test, so each is disabled on its line with a reason, and neither is renamed.

## Change

- `eslint.config.ts`: `"clean-code/names-describe-side-effects": "error"` with a one-line reason, added to the `adopted` object beside `be-precise`.
- `src/ticket-mode/ui.test.ts`: an `eslint-disable-next-line` above the `getElementById` fake. The page script `src/ticket-mode/ui.html` calls the DOM method by that name.
- `src/work-tick-health.test.ts`: an `eslint-disable-next-line` above the `find` fake in `sink()`. The member implements `RecordIo.find` (`src/work-tick-health.ts`), whose name the type fixes.

No runtime code changes. The fakes' code is unchanged.

## Acceptance

`npm run lint` exits 0 with the rule at `error`, and reports no hit for it. The two test files pass under the rstest suite against a fixture host declaration.

Acceptance: `bash -c 'set -e; npm run lint; npm run typecheck; P=$(mktemp -d); cp -r src/packaging/fixtures/project-tree/. "$P"; sed -i "s|@@PROJECT@@|$P|" "$P/.agent-org/host.json"; git -C "$P" init -q; git -C "$P" add -A; git -C "$P" -c user.name=ci -c user.email=ci@localhost commit -q -m fixture; AGENT_ORG_HOST="$P/.agent-org/host.json" npm exec -- rstest run --config scripts/rstest/rstest.config.ts src/ticket-mode/ui.test.ts src/work-tick-health.test.ts'`
