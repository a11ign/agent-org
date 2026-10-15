---
"@a11ign/agent-org": patch
---

Release tags no longer carry an installed `node_modules/`. agent-org had no `.gitignore`, and the release commit is staged with `git add -A`, so every tag from v0.155.5 carried 2,278 tracked `node_modules/` files and a plain `npm install` of such a tag failed (a11ign/agent-org#931). A `.gitignore` naming `node_modules/` now keeps it out; `src/packaging/gitignore-covers-install.test.ts` pins the rule with a positive and a negative control, and a staging case that stages a scratch project the way a release does.
