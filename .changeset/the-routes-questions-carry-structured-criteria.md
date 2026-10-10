---
"agent-org": patch
---

The model route's questions are sent to the decision provider as TypeSafe's structured criteria: each `choice` option is `{ what, not_for, examples }` and each `score` level `{ summary, signals, examples }`, where #4764 rendered the same data into one string per option. `mechanical` and `debugging` carry options and examples too (they were bare "true of this row" glosses), and every example is a row of ours with the merge that settled it, the file and line counts re-measured per row. `Described` (a string, an object or an array, which is what the API's schema takes for a description) widens the criteria types of `Question` and `ProviderQuestion`; no other use changes and the provider-absent route is byte-for-byte what it was. a11ign/a11ign#4752.
