---
"@a11ign/agent-org": patch
---

The acceptance-command scan charges a file `corpus` only for a `runsRoot()` CALL in its code, not for a string literal that merely names it (a11ign/agent-org#1327). A row whose Acceptance file sits next to a test that only quotes `runsRoot()` in a title or a message was refused at `pr:open` as needing a corpus it never reads. The two env-var spellings (`RUNS_ROOT`, `A11Y_RUNS_ROOT`) stay charged even inside a string, because `process.env["A11Y_RUNS_ROOT"]` is a real read; a `runsRoot()` call inside a template substitution stays charged too.
