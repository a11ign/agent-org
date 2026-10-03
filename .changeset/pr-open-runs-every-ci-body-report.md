---
"agent-org": patch
---

`pr:open` and `pr:edit` now run every report CI's acceptance job runs over a body (a11ign/a11ign#3209). `checkBody` composed two (Acceptance, Closes) while the CI entry composed four, so a body with no `Mutation:` record, or a `## Measured` section with no command and output, passed `pr:open` and went red in CI (8 of 9 sampled acceptance failures were `MUTATION: MISSING`). The four are now one exported list, `CI_BODY_REPORTS`, run by `runCiBodyReports` from both the CLI entry and `checkBody`, so a fifth report reaches `pr:open` with no second edit. The diff `mutationRecordReport` needs is read from the local tree with `ACMR` and `--no-renames`, as CI reads it; one that cannot be read is `UNCHECKED` and not a refusal. The acceptance report's whole-suite NOTE now prints from `pr:open` too, because it is part of what CI prints.
