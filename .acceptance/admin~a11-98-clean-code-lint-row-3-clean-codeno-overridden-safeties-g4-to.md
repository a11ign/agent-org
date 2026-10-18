## What it is

`clean-code/no-overridden-safeties` (Clean Code G4) was at `warn` in `eslint.config.ts`. This change raises it to `error`, configured as A11-107 decides: `{ allowEmptyCatch: true, allowTsIgnore: true, requireDisableReason: true }`. As A11-107 decides, the two options allow an empty catch and any `@ts-ignore` or `@ts-nocheck`, without a reason. They keep this rule from duplicating `no-empty` and `ban-ts-comment`, but neither is enabled in this repo, so nothing else checks those two forms. An `eslint-disable` with no `--` reason fails the lint.

On `origin/main` (`ef2d63fb`) the rule reports 2 hits, both `@ts-ignore` lines that already carry a reason: `src/lib/spawn-census.ts:154` and `src/unwaited-stock-rows-standing-waits.test.ts:6`. Both stay as they are. No source file changes.

## Change

- `eslint.config.ts`: the `clean-code/no-overridden-safeties` line in `recommended` is `["error", { allowEmptyCatch: true, allowTsIgnore: true, requireDisableReason: true }]`, with the reason as a trailing comment.

## Acceptance

Lint exits 0 with the rule at 0 hits, the rule resolves to `error` with the three options, a live probe shows an `eslint-disable` without a reason is still reported and one with a reason is not, and typecheck and the lint-job test pass.

Acceptance:
```bash
set -e
npm run lint
npm run typecheck
npx eslint src scripts -f json | node -e 'const r=JSON.parse(require("fs").readFileSync(0,"utf8"));const n=r.flatMap((f)=>f.messages).filter((m)=>m.ruleId==="clean-code/no-overridden-safeties").length;if(n!==0){console.error(n+" no-overridden-safeties hits");process.exit(1)}'
npx eslint --print-config src/lib/spawn-census.ts | node -e 'const c=JSON.parse(require("fs").readFileSync(0,"utf8")).rules["clean-code/no-overridden-safeties"];if(c[0]!==2||c[1].allowEmptyCatch!==true||c[1].allowTsIgnore!==true||c[1].requireDisableReason!==true)process.exit(1)'
printf '/* eslint-disable no-undef */\nexport const b = 1;\n' | npx eslint --stdin --stdin-filename src/zz-probe.ts -f json | node -e 'const r=JSON.parse(require("fs").readFileSync(0,"utf8"));if(!r[0].messages.some((m)=>m.ruleId==="clean-code/no-overridden-safeties"))process.exit(1)'
printf '/* eslint-disable no-undef -- a reason */\nexport const b = 1;\n' | npx eslint --stdin --stdin-filename src/zz-probe.ts -f json | node -e 'const r=JSON.parse(require("fs").readFileSync(0,"utf8"));if(r[0].messages.some((m)=>m.ruleId==="clean-code/no-overridden-safeties"))process.exit(1)'
printf 'export function f() { try { g(); } catch (e) {} }\nfunction g() {}\n// @ts-ignore\nexport const a: number = "x";\n// @ts-nocheck\nexport const c: number = "y";\n' | npx eslint --stdin --stdin-filename src/zz-probe.ts -f json | node -e 'const r=JSON.parse(require("fs").readFileSync(0,"utf8"));if(r[0].messages.some((m)=>m.ruleId==="clean-code/no-overridden-safeties"))process.exit(1)'
P=$(mktemp -d); cp -r src/packaging/fixtures/project-tree/. "$P"; sed -i "s|@@PROJECT@@|$P|" "$P/.agent-org/host.json"; git -C "$P" init -q; git -C "$P" add -A; git -C "$P" -c user.name=ci -c user.email=ci@localhost commit -q -m fixture
AGENT_ORG_HOST="$P/.agent-org/host.json" npm exec -- rstest run --config scripts/rstest/rstest.config.ts src/ci-lint-job.test.ts
```
