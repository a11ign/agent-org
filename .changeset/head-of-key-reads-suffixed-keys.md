---
"agent-org": patch
---

The trace's head-moved check reads the head out of a settled-red order key that ends `/conflicting` or `/refail-<n>`. `HEAD_OF_KEY` in `src/trace/aggregate.ts` was anchored at the end of the key, so such a key read no head, and a repeat whose head had moved to a different one counted as unchanged. Keys with no head before the suffix still read none.
