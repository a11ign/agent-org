---
"agent-org": patch
---

`wakes:per-row` prints its reading when run as a command. Since `c2d79f8` its entry module sat in a top-level `await main()` while `main` imported `trace`, which imports the module back, so node exited 13 ("unsettled top-level await") with nothing printed and nobody could take the after reading. A test now runs the command end to end. a11ign/a11ign#3452.
