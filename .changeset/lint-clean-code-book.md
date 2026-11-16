---
"agent-org": patch
---

The repository's lint is now eslint-plugin-clean-code-book's `recommended`, `typescript`, `ai` and `jsdoc` configs, in place of `@george2f/eslint-plugin-clean-code`. The plugin is vendored as a tarball in `vendor/` until it has a published home. The 89,110 reports the tree already had are recorded in `eslint-suppressions.json` (ESLint's bulk suppressions): new code must pass every rule, and the file only shrinks. The 88 `eslint-disable` comments that named the old plugin's rules are gone.
