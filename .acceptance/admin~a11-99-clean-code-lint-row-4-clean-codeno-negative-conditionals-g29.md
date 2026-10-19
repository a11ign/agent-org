## What it is

`clean-code/no-negative-conditionals` (Clean Code G29) was at `warn` in `eslint.config.ts`, so `npm run lint` passed while the code still had negated `if`/`else` and ternaries. This change fixes all 26 hits on `main` `c0c5ab80` (25 in production code, 1 in a test) and raises the rule to `error`. The rule has no options, so fixing is the only way to reach zero.

Each rewrite keeps the branches and their order of evaluation. Where a negated test becomes a positive one, the two branches swap. Where a nested ternary would have resulted, the chain is flattened so each test reads positively. Every message string, exit code and return value is unchanged.

## Change

- `eslint.config.ts`: the `clean-code/no-negative-conditionals` line in `recommended` is `"error"`. No other line changes.
- The 26 hits in 19 production and test files. The rule reports them in these files only: `src/acceptance-commands/classification.ts`, `src/b4-cycle.ts`, `src/board-document.ts`, `src/board-report.ts`, `src/decision-run/classes/answer-owed.ts`, `src/decision-run/classes/ready-queue-empty.ts`, `src/decision-run/classes/ready-rows-untiered.ts`, `src/decision-run/classes/unclaimed-blocker-cleared.ts`, `src/install/doctor.ts`, `src/messaging/converse.ts`, `src/review-eval.test.ts`, `src/row-file/body-from-argv.ts`, `src/row-file/roadmap-without-parent-refusal.ts`, `src/spec-lint.ts`, `src/ticket-mode/stack-live-check-command.ts`, `src/untiered-ready-rows.ts`, `src/wake/ensure-reviewer-token.ts`, `src/wakes-per-row.ts`, `src/work-tick.ts`.

No runtime behaviour changes. The changes are a branch swap, a positive-test rewrite, or a flattened chain, each checked by hand.

## Acceptance

Lint exits 0 with no hit for the rule. Typecheck passes. The rule resolves to `error` (severity 2) in the resolved config. A live probe shows the rule still reports a negated ternary, so a silent un-registering would fail. The test files that import the touched modules, and that do not fail on `c0c5ab80` in this environment, pass under the rstest suite against a fixture host declaration.

Acceptance:
```bash
set -e
npm run lint
npm run typecheck
test "$(npx eslint src scripts -f json | node -e 'const r=JSON.parse(require("fs").readFileSync(0,"utf8"));console.log(r.flatMap((f)=>f.messages).filter((m)=>m.ruleId==="clean-code/no-negative-conditionals").length)')" = 0
npx eslint --print-config src/b4-cycle.ts | node -e 'const c=JSON.parse(require("fs").readFileSync(0,"utf8")).rules["clean-code/no-negative-conditionals"];if(c[0]!==2)process.exit(1)'
printf 'export const f = (a: boolean) => (!a ? 1 : 2);\n' | npx eslint --stdin --stdin-filename src/zz-probe.ts -f json | node -e 'const r=JSON.parse(require("fs").readFileSync(0,"utf8"));if(!r[0].messages.some((m)=>m.ruleId==="clean-code/no-negative-conditionals"))process.exit(1)'
P=$(mktemp -d); cp -r src/packaging/fixtures/project-tree/. "$P"; sed -i "s|@@PROJECT@@|$P|" "$P/.agent-org/host.json"; git -C "$P" init -q; git -C "$P" add -A; git -C "$P" -c user.name=ci -c user.email=ci@localhost commit -q -m fixture
AGENT_ORG_HOST="$P/.agent-org/host.json" npm exec -- rstest run --config scripts/rstest/rstest.config.ts src/b4-cycle.test.ts src/review-eval.test.ts src/decision-run/classes/answer-owed.test.ts src/decision-run/classes/ready-queue-empty.test.ts src/decision-run/classes/ready-rows-untiered.test.ts src/decision-run/classes/unclaimed-blocker-cleared.test.ts src/messaging/converse.test.ts src/install/doctor.test.ts src/spec-lint.test.ts src/untiered-ready-rows.test.ts src/wakes-per-row.test.ts src/work-tick-cost.test.ts src/packaging/row-file.test.ts src/packaging/acceptance-commands.test.ts src/ticket-mode/serve-ticket-only-host.test.ts src/packaging/board-report-smoke.test.ts
```
