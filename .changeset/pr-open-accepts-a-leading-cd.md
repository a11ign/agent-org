---
"agent-org": patch
---

`pr:open` no longer refuses a row's own `cd <dir> && …` Acceptance with "an `&&`" (a11ign/a11ign#3596, found on #3593). `testFileArgumentsResolve` asked `unparseableConstruct` about the UNSTRIPPED line, so the `&&` that #3026 had declared legitimate was the construct it refused, and every agent-org row written in the shape the engineer brief prescribes had to be rewritten at PR time. It now asks about the line without its leading `cd`, and looks the runner's file arguments up in the `cd` target (not this process's directory); a SECOND `&&` is still refused.
