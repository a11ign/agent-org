The README's ticket-mode key table links each key to its entry in `src/ticket-mode/config-schema.ts`, and each key is described once, in the schema. `src/ticket-mode/readme-keys.test.ts` reads the table and fails, naming the row's line, when a key cell is not such a link, a row carries text beyond its key, a key is not one the schema describes, or a key appears in two rows.

Acceptance:
```bash
npx rstest run --config scripts/rstest/rstest.config.ts src/ticket-mode/readme-keys.test.ts src/ticket-mode/config-schema.test.ts
```

Mutation: a description was put back into the `tickets.drafts` row (`README.md:390`). The test went red naming that row (`README.md:390: tickets.drafts carries text beyond its key cell`), and the README was restored and passes again.

Before this change the test fails on all 27 rows of the table, each named by its line.

Consumer-declaration: the Settings page reads these explanations (`src/ticket-mode/settings-view.ts`). `settings-view.test.ts`, `settings-read.test.ts` and `settings-edit.test.ts` pass, and no key's value, reader or validation changes.
