---
"agent-org": patch
---

The README names the `.mjs` ratchet and no longer gives a rise rule. Its source-file paragraph still said `src/packaging/mjs-source-count.test.ts` pins the count and that a shipped command's import may raise it; that test was deleted by a11ign/agent-org#419, and the ratchet (`mjs-ratchet.test.ts` against `mjs-ratchet.baseline.json`) has no raise: a new file is `.ts`. One comment in `worker-profile-headless.test.ts` named the same deleted test and now names the ratchet. a11ign/a11ign#4299.
