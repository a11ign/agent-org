In a repository whose merge flow is the merge bot (private, `.github/workflows/merge-bot.yml` on its default branch) and that has no ruleset, the board takes `gate` as the one required check: a red check that is not the merge condition is listed and reported to the reviewer as an unrequired red, never holds a reviewer start, and opens no feedback round. A red `gate` reads red, and a repository with neither a ruleset nor the merge bot counts every check as before.

Acceptance:
```bash
npx rstest run --config scripts/rstest/rstest.config.ts plugins/github/pull-feedback.test.ts plugins/github/code-host.test.ts plugins/github/merge-flow.test.ts
```

Consumer-declaration: none -- no existing host file changes meaning. A repository with a ruleset, or with no merge bot, is read as before.
