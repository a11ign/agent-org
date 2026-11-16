The answerer's offline test (A11-438, step 2 of 2). `src/ticket-mode/auto-answer-replay.ts` replays past Needs-you questions a person already answered through the answerer's live gate, prompt and threshold, has a judge model say whether each automatic answer agrees with the person's, and scores agreement against the bar: at least 95% on at least 20 answered questions. `scripts/replay-auto-answer.ts` runs it with `claude -p`, stopping at `tickets.evalTokenCap`. The set and the full result stay in the host's state directory (agent-org is public); `evals/auto-answer/result.json` is the checked-in public result: ticket keys, what came of each, confidence, agreement and the score. `DEFAULT_AUTO_ANSWER` in `settings.ts` follows that result, held by a test. The replay of 10 past questions answered none at the 0.9 threshold, so the key stays off.

Acceptance:
```bash
npx rstest run --config scripts/rstest/rstest.config.ts src/ticket-mode/auto-answer-replay.test.ts src/ticket-mode/auto-answer.test.ts src/ticket-mode/pool-auto-answer.test.ts src/ticket-mode/pool-answer.test.ts src/ticket-mode/settings.test.ts src/ticket-mode/config-schema.test.ts
npx rstest run --config scripts/rstest/rstest.config.ts src/ticket-mode/interventions.test.ts -t "A11-438"
```

Mutation: set `DEFAULT_AUTO_ANSWER` to true while the stored result misses the bar, and "the key is on by default exactly when the stored replay meets the bar" fails. Change `AGREEMENT_BAR` to 0.9, and "19 of 20 / 18 of 20" fails. Drop `answered >= MIN_ANSWERED` from `meetsBar`, and "100% of too few" fails. Skip the `isAnswerableItem` gate in `replayCase`, and the not-tried cases fail. Keep `why` or `answer` in `publicResultOf`, and "the checked-in result carries no question, answer or reason" fails.

Consumer-declaration: no new host file key, route or queue field. `tickets.autoAnswer`'s default is unchanged (false).
