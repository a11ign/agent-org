In a private repository with no required check, the board waits on `gate` alone when the pull request's head holds `.github/workflows/merge-bot.yml`, as well as when the default branch does (`runsMergeBot`, `readHeadHoldsMergeBot` in `plugins/github/merge-flow.ts`). With `gate` green and another check red, a reviewer starts (`readReviewState` is settled and names the red check as unrequired) and the board's feedback read counts no failing check. A repository with the bot on neither the default branch nor the head counts every check, as before.

Acceptance:
```bash
npx rstest run --config scripts/rstest/rstest.config.ts plugins/github/pull-feedback.test.ts plugins/github/code-host.test.ts plugins/github/merge-flow.test.ts
```

Consumer-declaration: none -- no host file, queue file or setting changes meaning. A repository with a ruleset, a public one, and a private one without the merge bot are read as before.
