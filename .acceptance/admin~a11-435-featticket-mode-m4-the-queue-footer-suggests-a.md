The queue footer suggests a model and effort (A11-435, step 1 of 1): `src/ticket-mode/suggest-model.ts` reads the outcome log (A11-430), groups the decided worker runs of each label the selected tickets share in their one repository by model and effort, and suggests the best first-pass rate among those with at least `tickets.suggestMinSample` runs (20 by default). `GET /api/suggestion?keys=` answers it, and the Tickets page's queue bar shows it with its reason and sample size. It only advises: Queue sends the batch's own choice.

Acceptance:
```bash
npx rstest run --config scripts/rstest/rstest.config.ts src/ticket-mode/suggest-model.test.ts src/ticket-mode/settings.test.ts
pnpm --dir ui exec rstest run --config rstest.config.ts src/tickets/tickets-suggestion.test.tsx
npx rstest run --config scripts/rstest/rstest.config.ts src/ticket-mode/interventions.test.ts -t "A11-435"
pnpm ui:build && pnpm --dir ui exec rstest run --config rstest.config.ts test/responsive/responsive-tickets.page.test.ts -t "one row high"
```

Mutation: make `suggestionOf` ignore `minSample`, and "fewer past runs of the kind than the minimum sample size suggest nothing" fails. Count a run sent back for a review round as a first pass in `passedSoFar`, and the 94% test fails on 100%. Drop the `latestOutcomes` call, and "a run is counted once, by its latest record" fails. Make the footer queue on the suggestion (`batch.setOverride` from the suggestion), and "does not choose for the person" fails on its posted model. Stop rendering `SuggestionLine` in `QueueBar`, and the footer tests fail. Drop `/api/suggestion` from the proxy's `READS`, and the A11-435 proxy test fails. Give `.queue-bar-suggestion` `flex: 0 1 auto` again, and the 390px check fails: the line wraps the bar to a second row.

Consumer-declaration: one new optional host file key, `tickets.suggestMinSample`, read only by `parseTicketSettings`; a host file without it reads as before. One new read route, `GET /api/suggestion`, read only by the Tickets page; an instance from before it answers 404, and the page then shows no suggestion.
