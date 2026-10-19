## What it is

`clean-code/encapsulate-conditionals` (Clean Code G28) counted 182 conditions on the stacked base that have more than two logical operators, across 131 files. A `warn` does not fail the lint, so a new hit could land unseen. This change names every such condition, and raises the rule to `error`.

## Change

- `eslint.config.ts`: `clean-code/encapsulate-conditionals` is `"error"` in the `adopted` block, with a reason beside it. One file is exempt: `src/lib/walk-scope.ts`, a copy of `packages/guards/src/walk-scope.ts`. `copies-drifted` (`src/org-health/sweep-readings.ts`) reads any change to a copy's body as drift, and an edit there made the `wait-condition` test fail. The copy keeps its original condition, and the fix belongs in the original, in a11ign.
- Each condition is named by a `const` placed directly before the statement that uses it, for example `const isMalformedPage = ...; if (isMalformedPage) {`. Where the condition narrows a property (`value.run`, `entry.headSha`), which TypeScript does not carry through an aliased condition, the narrowing check stays inline and only the rest is named, or a type-guard predicate is used (`isKeysRun`, `isTeamPick`, `isPlace`, `isReadyRow`).
- `else if` chains whose condition was named became `else { const …; if (…) }`, or use a closure evaluated at the same point (`isClosedAfterAffirmed()`).
- No `eslint-disable` was needed: every hit was a real condition, and each is fixed in the code.
- No behaviour change: operands keep their order and short-circuit, and no side-effecting call moved.

## Acceptance

Lint exits 0 with the rule at `error`, the rule reports 0 hits, its config is `error` for production source, and typecheck passes.

Acceptance:
```bash
set -e
npm run lint
npm run typecheck
npx eslint src scripts -f json | node -e 'const r=JSON.parse(require("fs").readFileSync(0,"utf8"));const n=r.flatMap((f)=>f.messages).filter((m)=>m.ruleId==="clean-code/encapsulate-conditionals").length;if(n!==0){console.error(n+" encapsulate-conditionals hits");process.exit(1)}'
npx eslint --print-config src/wake.ts | node -e 'const c=JSON.parse(require("fs").readFileSync(0,"utf8"));if(c.rules["clean-code/encapsulate-conditionals"][0]!==2)process.exit(1)'
grep -n 'encapsulate-conditionals' eslint.config.ts
```
