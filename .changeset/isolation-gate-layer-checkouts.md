---
"agent-org": patch
---

The isolation gate's copy leaves out the checkout of a layer that has a repository of its own (`layers.json`, a layer with a `remote`) and says how many it left out, because that layer publishes from its own repository and its `prepack` needs a `pnpm` the lab does not have. This matches the original, which `agent-org-wiring.test.ts` compares (a11ign/a11ign#3830).
