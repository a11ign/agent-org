---
"agent-org": patch
---

The trace map's `gh` reads of a row's record (`issues/N`), a pull request's record (`pulls/N`) and a head's `check-runs` send the ETag they were last given, and a 304 is answered from the body kept with it, which costs no point of the core pool. A row whose record answers 304 and whose `filed` event the store already holds skips its timeline read, which was 51 of the 105 calls a render spent re-reading the subjects the wakes name (measured on one render, 123 calls in all). The validators live in `.validators.json` beside the trace store; a missing or corrupt file means unconditional requests, never a skipped read. A subject whose reading was cut off (by the budget or a failure) forgets the validator of its own record (`pulls/N` for a pull request, `issues/N` for a row), so the next run reads it whole. The timeline and the lists are not conditional: their ETags were measured not to hold. a11ign/a11ign#4097.
