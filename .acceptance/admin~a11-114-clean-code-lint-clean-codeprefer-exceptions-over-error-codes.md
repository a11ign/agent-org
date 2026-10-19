## What it is

`clean-code/prefer-exceptions-over-error-codes` (Ch3) flags a `return -1;` statement, which is an error code. It was not on in `eslint.config.ts`. This change turns it on at `error`. It had 0 hits in `src` and `scripts`, so no code changes.

## Change

- `eslint.config.ts`: `"clean-code/prefer-exceptions-over-error-codes": "error"` joins the `adopted` object, with a one-line reason beside it: only a `return -1;` statement is flagged, so a sort comparator is written in expression form, which is not flagged; a block-bodied `return -1` that is not an error code takes an `eslint-disable-next-line` with a reason.

## Acceptance

`npm run lint` and `npm run typecheck` pass. The rule is on at `error`: a block-bodied comparator that returns `-1` is flagged, and the expression-form comparator is not. Both probes read a snippet on stdin, so no file is written to the tree.

Acceptance: `bash -c 'set -e; npm run lint; npm run typecheck; if ! (printf "export function f(xs: number[]) {\n  return xs.sort((a, b) => {\n    if (a < b) return -1;\n    return 1;\n  });\n}\n" | npx eslint --stdin --stdin-filename src/zz-probe.ts | grep -q prefer-exceptions-over-error-codes); then echo "rule is not reported at error" >&2; exit 1; fi; printf "export function f(xs: number[]) {\n  return xs.sort((a, b) => (a < b ? -1 : 1));\n}\n" | npx eslint --stdin --stdin-filename src/zz-probe.ts'`
