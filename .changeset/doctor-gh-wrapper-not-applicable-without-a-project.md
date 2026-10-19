---
"agent-org": patch
---

`agent-org doctor` no longer fails the `gh wrapper` check on a host file that declares no `primary` project. A machine that runs only the ticket board has no project to render a wrapper from, so the check said "field `primary` REFUSED: it is missing" and `doctor` could never pass there. It now reports the check as not applicable. A host that declares a `primary` is checked as before.
