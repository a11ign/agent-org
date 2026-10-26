Refs A11-291

Follow-up to the merged a11ign/agent-org#1943, after the chairman's decision that private repositories get a merge bot, not a ruleset ([A11-291, Decisions: "Private repositories get a merge bot, not a ruleset"](https://linear.app/a11ign/issue/A11-291/approved-pull-requests-sit-for-a-day-in-four-repositories-with-no)): the ticket's line "Doctor's merge-flow check (this ticket) accepts either a ruleset with auto-merge, or the merge bot for a private repository on a plan without rulesets". `MergeFlow` (code host contract 1.27) gains `private` and `mergeBot`, read in the one query; doctor's `merge flow` row passes a private repository that holds `.github/workflows/merge-bot.yml` and asks a private repository without it for the bot; the card's reason for a private repository is the bot's; a pull request that adds the arm workflow or the merge bot to a repository with neither is a first install (card and `pr:open` body).

Acceptance:
```bash
npx rstest run --config scripts/rstest/rstest.config.ts plugins/github/merge-flow-checks.test.ts plugins/github/merge-flow.test.ts
npx rstest run --config scripts/rstest/rstest.config.ts src/packaging/first-merge-flow-report.test.ts src/ticket-mode/board-view/not-merging.test.ts
npm run typecheck
npm run lint
```
Run the rstest lines with `AGENT_ORG_HOST` naming a host declaration, as CI's `suite` job does.

After merge: `agent-org doctor` on the agents host has a `merge flow` row that passes `plugin` and `auth-capture-check` by their merge bot (once a11ign/plugin#11 and a11ign/auth-capture-check#20 are merged) and names any repository that lacks a flow.
