---
"agent-org": patch
---

The tick's review tree links each package under the name its `package.json` declares, not its directory's: `@a11ign/x` lands in `node_modules/@a11ign/x` and an unscoped package such as `a11ign` directly in `node_modules/`, so a reviewer's Acceptance can import a renamed package. An entry with no readable manifest is skipped, the unscoped link is the tree's own and never the checkout's, and a link whose package was removed or renamed is removed.
