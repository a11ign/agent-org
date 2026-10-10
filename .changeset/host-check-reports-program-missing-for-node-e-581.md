---
"agent-org": patch
---

`host:check` no longer reports `PROGRAM MISSING` for a unit whose `ExecStartPre` is `node -e "<code>"` (a load check): `scriptOfNode` returns nothing when node is handed inline code (`-e`, `--eval`, `-p`, `--print`), instead of reading the code as the script path.
