---
"agent-org": patch
---

The copies `src/lib/git-sandbox.ts` and `src/lib/tree-wide-guard.mjs` carry their a11ign originals' renamed paths again: the comments name `tree-wide-guards.ts`, `local-import-closure.ts` and `git-env.ts` as the originals now do, and the headers name the originals' current last commits (`a0a4e91c8`, `f3b5c5f59`). `tree-wide-guard.mjs` names ten changed lines, the nine type lines and its one import, which stays `./git-env.mjs` because the tool's own `git-env.mjs` sits beside it. So org-health's `copies-drifted` reading no longer trips on either copy (a11ign/a11ign#4557).
