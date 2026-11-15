`GET /api/outcomes` rolls a time window's outcome records up by model and effort, repository and label, priced at the host file's `tickets.prices` read on each request (A11-430, step 2 of 3), and a run's record carries each Codex review of its pull requests with that review's tokens. Step 1's per-round record is unchanged, and its tests run here too.

Acceptance:
```bash
npx rstest run --config scripts/rstest/rstest.config.ts src/ticket-mode/outcomes/
npx rstest run --config scripts/rstest/rstest.config.ts src/ticket-mode/config-schema.test.ts src/ticket-mode/settings.test.ts src/ticket-mode/loop-load-routes.test.ts src/ticket-mode/interventions.test.ts src/trace/codex-price.test.ts src/packaging/trace-store-readers.test.ts
npx rstest run --config scripts/rstest/rstest.config.ts src/ticket-mode/pool.test.ts src/ticket-mode/queue.test.ts src/ticket-mode/run-log.test.ts -t "A11-430|the pool logs what it does to a run|a run ends on its outcome file"
```

Mutation: skip `holdsReview` in both `recordReview` (`src/ticket-mode/pool-reviewers.ts`) and `reviewEndOf` (`src/ticket-mode/outcomes/review-end.ts`), and "a pull request the reviewer reviewed twice" fails on a review recorded twice. In `recordReview` (`src/ticket-mode/pool-reviewers.ts`) pass `run.since` as `after` in place of `reviewTurnsAfter`, and the same test fails on the second review's tokens (the first review's requests counted again). In `outcomesAnswer` (`src/ticket-mode/outcomes/route.ts`) price at `pricesOf(undefined)` in place of the host file's prices, and "a price changed in the host file" fails. In `runViewOf` (`rollup.ts`) drop the unread round's floor, and the sonnet/medium figure is no longer a floor.

Consumer-declaration: one new host file key, `tickets.prices` (optional; absent keeps the published table), described in `config-schema.ts`. No contract changes. The UI reads `/api/outcomes` in step 3.
