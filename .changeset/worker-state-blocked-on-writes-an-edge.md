---
"@a11ign/agent-org": patch
---

`worker:state blocked <row> --on <n> <reason>` writes a native `blockedBy` edge from `<row>` to `<n>` and posts the reason, with no `answer:` label, because no answer is owed (a11ign/agent-org#921). A closed `--on` row, or the row itself, is refused by name. If the edge cannot be written the command falls back to the label, so the worker is never blocked with nobody told. Without `--on` the command is unchanged.
