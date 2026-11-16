The readiness score for tickets (A11-443). Step 1 (#2062) added the score behind `tickets.readiness`, off by default, cached by the description's hash, with "Improve with the writer". Step 2 adds its offline test: `src/ticket-mode/readiness-check.ts` sets past tickets' scores against how their runs went (rounds per run and Needs-you rounds from M1's outcome records, re-plans from the queue's run log), and `scripts/check-readiness.ts` runs it on a host with the board's own scorer. Its first run, over 10 tickets, found no clear link, so `evals/readiness/result.json` says `meetsBar: false` and `DEFAULT_READINESS` stays `false`; a test holds the default, the parsed setting and the Settings page's default to the stored result.

Acceptance:
```bash
npx rstest run --config scripts/rstest/rstest.config.ts src/ticket-mode/readiness-check.test.ts src/ticket-mode/readiness.test.ts src/ticket-mode/settings.test.ts src/ticket-mode/config-schema.test.ts
npx rstest run --config scripts/rstest/rstest.config.ts src/ticket-mode/server.test.ts -t "A11-443"
pnpm --dir ui install --frozen-lockfile
pnpm --dir ui exec rstest run --config rstest.config.ts src/tickets/tickets-readiness.test.tsx
```

Mutation: set `DEFAULT_READINESS = true` in `src/ticket-mode/settings.ts`, and "the key is on by default exactly when the stored check meets the bar" fails. Drop the `against.length === 0` part of `meetsBar`, and "the bar is missed ... with a measure where the low tickets did better" fails. Count every `requeued` event as a re-plan, and "a ticket's history ... counts its re-plans from the run log" fails.

Consumer-declaration: no new host file key and no new route. `tickets.readiness` reads its absent value from `DEFAULT_READINESS`, which is `false` as before. New state files `<stateDir>/evals/readiness/tickets.json` (the set, written by a person or a worker) and `<stateDir>/evals/readiness/result.json` (the full result), read and written only by `scripts/check-readiness.ts`.
