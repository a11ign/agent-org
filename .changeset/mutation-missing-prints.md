---
"agent-org": minor
---

`MUTATION: MISSING` is a printed line and no longer fails (a11ign/a11ign#3282, decided on #3213). `mutationRecordReport` returns `ok: true` for a diff that changes a test with no `Mutation:` record, so CI's acceptance job and `pr:open` print the omission and go on; a DUPLICATE `Mutation:` header still fails, being a body the parser cannot read as one record. The project posts the survivors of a machine-chosen mutant set as a pull request comment instead.
