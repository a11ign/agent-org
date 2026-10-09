---
"agent-org": patch
---

The repeating-lines allowlist knows a keyed `SHELVED row` (a11ign/a11ign#4617). `SHELVED row agent-org#460: blocked by #458 -- ...` is the same state as `SHELVED row #N: ...` and was offered to every `repeating-log-line` wake because the entry matched only the unkeyed spelling; it now matches an optional key before the `#`.
