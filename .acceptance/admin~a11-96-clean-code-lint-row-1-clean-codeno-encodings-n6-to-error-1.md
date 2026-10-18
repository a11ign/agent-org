## What it is

`clean-code/no-encodings` (Clean Code N6) reported one hit in agent-org: the private parameter `fnName` of `noTokenDeclarationHolds` in `src/acceptance-commands.ts`, which carries a Hungarian-style `fn` prefix. This change renames it to `calleeName` in all four places it occurs (the signature, the two `RegExp` template strings and the doc comment's example), and raises the rule to `error` in `eslint.config.ts`, so a new encoded name fails `npm run lint`.

## Change

- `src/acceptance-commands.ts`: the parameter renamed from `fnName` to `calleeName`. No regex, no logic and no export changes.
- `eslint.config.ts`: the `clean-code/no-encodings` line goes from `"warn"` to `"error"`. No other rule's line changes.

Refs A11-95

Flag: none. A private rename and a lint severity change; no runtime behaviour changes.
Health-signals: none
Revert: revert this PR. The parameter name returns to `fnName` and the rule returns to `warn`.

Acceptance:
```bash
npm run lint
npm run lint 2>&1 | grep -c "no-encodings" | grep -qx 0
npm run typecheck
F=$(mktemp -d) && cp -r src/packaging/fixtures/project-tree/. "$F" && sed -i "s|@@PROJECT@@|$F|" "$F/.agent-org/host.json" && git -C "$F" init -q && git -C "$F" add -A && git -C "$F" -c user.name=fixture -c user.email=fixture@example.invalid commit -q -m "the fixture project" && AGENT_ORG_HOST="$F/.agent-org/host.json" pnpm exec rstest run --config scripts/rstest/rstest.config.ts src/acceptance-commands.test.ts
```
