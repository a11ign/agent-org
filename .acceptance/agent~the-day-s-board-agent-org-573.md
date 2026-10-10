The day's board edition no longer judges the comments of a CLOSED row, so a handoff sentence or a reading under a finished row is neither a finding in the day's table nor an `answer:<route>` order. This is a11ign/agent-org#573.

Closes a11ign/agent-org#573

Class: answer-label-without-question — the closed-row case of an `answer:<route>` order reaching a seat with nothing to answer; guard: `answerLabelRefusal` at the label writer (a11ign/a11ign#4679) and, from this change, `commentsToJudge` never judging a closed row, so it is no finding to label.

Acceptance:
```bash
npx rstest run --config scripts/rstest/rstest.config.ts --include src/packaging/board-prose-skips-closed-rows.test.ts
npx rstest run --config scripts/rstest/rstest.config.ts --include src/board-truth-audit.test.ts
```

Mutation: the `CLOSED` skip in `commentsToJudge` made never to fire (`filter(() => true)`) -> 4 of 6 red in the new file (both closed-row cases and both `readProseFacts` cases), `board-truth-audit.test.ts` still 45 green; made always fire (`filter(() => false)`) -> 6 of 6 red (the open-row controls and the no-`state` case fail with the closed-row cases); `readProseFacts` never marking a listed row closed -> 2 of 6 red (the two `readProseFacts` cases), the `proseAudit`-level cases green. Each restored from a copy taken before and `diff`ed byte-identical.
