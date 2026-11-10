`MAX_CREATED` in `src/ticket-mode/writer-limits.ts` is 25: the PreToolUse hook allows a new-ticket run's twenty-fifth creation and refuses its twenty-sixth, and the New ticket dialog says "up to 25 tickets".

Acceptance:
```bash
npx rstest run --config scripts/rstest/rstest.config.ts src/ticket-mode/hook.test.ts src/ticket-mode/writer.test.ts
```

Mutation: set `MAX_CREATED` back to 10, and the hook test's "the twenty-fifth creation is allowed" assertion fails.

Consumer-declaration: none -- no host file key or contract changes; one constant's value.
