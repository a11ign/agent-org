The Settings page's Plugins section draws the contract mismatch rows the server's check returns (A11-138). Each row is one line of the section's list, starting `Mismatch:` and carrying the plugin and the host key from the check's sentence, under a visible label that says what the rows are and tied to it with `aria-labelledby`. A plugin with a matching contract, a plugin with no contract, and an instance whose answer has no `contract` field draw no label and no row. Nothing is read or checked on the page: the rows are the ones `/api/settings` returns.

Acceptance:
```bash
npx rstest run --config scripts/rstest/rstest.config.ts src/ticket-mode/ui.test.ts src/ticket-mode/settings-read.test.ts
npm run typecheck
npm run lint
```

Mutation: the page's `contractRows` was put back to the base page, which draws no rows; the test "each contract mismatch is a row in the Plugins section" went red and the other tests stayed green. The page was restored and the suite passed again.

Consumer-declaration: none -- no reader's answer changes: the view and `GET /api/settings` are the same. This PR makes A11-136's acceptance line "The Settings page receives the rows in its view and does not draw them (A11-138)" out of date; that file is A11-136's and is not edited here.
