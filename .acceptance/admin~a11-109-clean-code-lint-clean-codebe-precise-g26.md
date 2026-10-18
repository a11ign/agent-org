## What it is

`clean-code/be-precise` (G26) flags `===` and `!==` against a floating-point literal, and a bare `parseInt`. It was not on in `eslint.config.ts`. This change turns it on at `error`, with its one hit fixed.

## Change

- `eslint.config.ts`: a new `adopted` object holds `"clean-code/be-precise": "error"` with a one-line reason, spread into `rules` beside `recommended`.
- `src/trace/trace.test.ts`: the `COST:` test's `assert.ok(0.051018 !== costOf(...), msg)` becomes `assert.notEqual(costOf(...), 0.051018, msg)`. The same strict inequality, with the message and the comment above it unchanged.

## Acceptance

Lint and typecheck pass, and the trace tests pass against a fixture host declaration. `npm run lint` shows no `be-precise` line.

Acceptance: `bash -c 'set -e; npm run lint; npm run typecheck; P=$(mktemp -d); cp -r src/packaging/fixtures/project-tree/. "$P"; sed -i "s|@@PROJECT@@|$P|" "$P/.agent-org/host.json"; git -C "$P" init -q; git -C "$P" add -A; git -C "$P" -c user.name=ci -c user.email=ci@localhost commit -q -m fixture; AGENT_ORG_HOST="$P/.agent-org/host.json" npm exec -- rstest run --config scripts/rstest/rstest.config.ts src/trace/trace.test.ts'`
