---
"agent-org": patch
---

A keyed repository's first review's refusals each name something that works. When the clone has no `package.json` (the repository's first pull request adds it), the missing-dependency refusal no longer names `pnpm install` there, which answers `ERR_PNPM_NO_PKG_MANIFEST`: it names the install in the review tree and the move of its `node_modules` into the clone, and a clone with a manifest reads as before. A keyed reviewer herdr refuses with `blocked during startup` whose clone has no `trust_level = "trusted"` entry in the reviewer's codex config now says so, naming the file and the `[projects."<clone>"]` entry to add; any other refusal keeps its text.
