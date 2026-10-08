---
"agent-org": patch
---

`row-file` refuses a body whose `Waiting-for:` line is outside the grammar the gate reads (`closed #n`, `merged #n`, `labelled|unlabelled <label> #n`, `published <pkg>@<dist-tag>`, `<pkg> latest = next`, `tagged <tag>`, or `manual`), naming the forms and the `answer:<session>` label for a wait on a session's act. Filing, `--promote=` and `--board=` ask it through `fileRefusalReason`, so an old free-text line cannot be filed, promoted or boarded; `parseWaits` is the one reader, a fenced line is not read, and `manual` stays allowed. a11ign/a11ign#4229.
