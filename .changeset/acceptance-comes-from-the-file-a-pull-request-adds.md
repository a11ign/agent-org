---
"agent-org": minor
---

The Acceptance is read from the file a pull request ADDS under `.acceptance/`, falling back to the body (a11ign/a11ign ADR 0044, row 1). The file holds the body's own grammar and goes through the same `acceptanceReport` and `extract*Section` functions; the report prints `ACCEPTANCE-SOURCE: file <path>` or `ACCEPTANCE-SOURCE: body (deprecated)`, and two added files are refused as two `Acceptance:` headers are. `pr:open`/`pr:edit` refuse a diff that adds no file, naming it (`.acceptance/<branch with / as ~>.md`) and writing it from a body that carries an `Acceptance:`; `checkBody` takes `readFile` and a diff's `added` list. `.acceptance/` is exempt from the Region check, `ownedPaths` and B4. The reader is exported as `agent-org/acceptance-file`, and `acceptanceSourceOfThisPullRequest` from `agent-org/acceptance-commands`, for a project's workflow to read the same text the commands come from. `Closes` stays in the body.
