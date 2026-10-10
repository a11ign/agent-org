---
"agent-org": patch
---

`src/lib/git-env.ts`, `isolation-gate.ts`, `local-import-closure.ts` and `walk-scope.ts` carry the changes their a11ign originals took in #4654 (the consumer's `type=module`), #4713 and #4725 (two comment lines each naming `@a11ign/toolchain/lib/...`), and their headers name the commit they were carried to. `walk-scope.ts` keeps its sibling copies of `walk-scope-declaration` and `walk-scope-discovery` and names them in its header, so the named count is 68. `copies-drifted` no longer trips on these. a11ign/agent-org#565.
