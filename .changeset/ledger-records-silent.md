---
"agent-org": patch
---

A `sent` ledger line records `silent`, the flag the provider says it APPLIED (a boolean, or `null` when the provider returned none), so "was the summary silent" is answerable from `ledger.jsonl` and no longer only from a reading of the code path (a11ign/a11ign#3385, found closing #2905). It is the applied flag and not the requested one: a provider that drops `silent` records `false`. Lines already written carry no key and stay so.
