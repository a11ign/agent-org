---
"agent-org": patch
---

`src/lib/walk-scope.ts` carries a11ign#4848's two `NOT_WRAPPED.test` entries, `expectFailure` and `getTestContext`, and its header names `42cfb887d`, so `copies-drifted` no longer trips on it. a11ign/agent-org#691.
