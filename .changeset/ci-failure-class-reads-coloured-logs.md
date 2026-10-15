---
"@a11ign/agent-org": patch
---

`ci-failure-class` now reads a coloured Actions job log (a11ign#4627, found by a11ign#4880). `gh api .../actions/jobs/<id>/logs` exits 1 on the colour codes an Actions log carries, so the read threw, the wake fell back to the order as the gate wrote it, and no class was ever asked or recorded. The log read passes `--allow-escape-sequences` and the escape bytes are stripped before the error lines and the rate-limit and runner-lost facts are matched, so a coloured `##[error]` still matches.
