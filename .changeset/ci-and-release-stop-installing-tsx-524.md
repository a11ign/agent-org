---
"agent-org": patch
---

`ci.yml` and `release.yml` no longer install `tsx`: Node 24 runs the `.ts` programs itself, so the release's consumer check is `node --test` on Node 24.21.0 like `ci.yml`. The two workflow helpers, `leak-scan` and `workflow-paths`, are `.ts` (history kept) and `mjs-ratchet.baseline.json` is empty, so the tree holds no `.mjs`, `.js` or `.cjs`.
