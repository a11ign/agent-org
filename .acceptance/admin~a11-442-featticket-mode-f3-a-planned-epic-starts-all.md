A planned batch's tickets with no unfinished blocker start in one pass, side by side, within `tickets.max` (A11-442, step 1 of 2). The queue (`nextStarts`) already chose every one of them in one pass; `fill` in `src/ticket-mode/pool-start.ts` then opened them one after another, awaiting each start (its tracker reads, its herdr pane and agent start, and up to 9 s of settling) before the next began. It now opens the starts a pass chose together (`openChosen`) and waits for all of them before the pass ends; stacked review rounds, which fetch and merge their base in a shared clone before they open, still open one after another. Who starts is unchanged: the blocker, slot and overlap rules decide before any start opens.

Acceptance:
```bash
npx rstest run --config scripts/rstest/rstest.config.ts src/ticket-mode/pool-parallel-starts.test.ts
```

Mutation: in `openChosen` in `src/ticket-mode/pool-start.ts`, replace `opening.push(batch.length > 1 ? startBatch(ctx, batch) : startOne(ctx, entry));` with `rounds = rounds.then(() => (batch.length > 1 ? startBatch(ctx, batch) : startOne(ctx, entry)));` (every start one after another, as before), and the first test fails: only A11-500's agent is started while its settle is held. Remove the `mergesBaseFirst` line's chain instead (`opening.push` for every run), and the third fails: two stacked rounds fetch their base in one clone at once.

Consumer-declaration: none -- no host file key, contract or queue field changes.
