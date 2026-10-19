Every query that reads a Linear project asks for its short text as `description`, under the name `summary`, because Linear's GraphQL `Project` type has no `summary` field and answers 400 to one that names it. The own list, a team's list, a single read, the projects' summaries and a scope's page all keep working, and a ticket still carries its project's text as `projectSummary`.

Acceptance:
```bash
npx rstest run --config scripts/rstest/rstest.config.ts src/ticket-mode/linear.test.ts
```

Mutation: each of the two queries was put back to the bare `summary` field, and each time the suite went red (the list query broke 3 tests, the projects read broke 1); both were restored and the suite passed again.

Consumer-declaration: none -- the alias keeps the answer's key `summary`, so no reader of a ticket's `projectSummary` or of the projects' summaries changes.
