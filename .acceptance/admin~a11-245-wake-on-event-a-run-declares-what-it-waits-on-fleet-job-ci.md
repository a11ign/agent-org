Refs A11-245

Step 1 of 2 (agent-org): the reads, with no behaviour change to a run. The code host contract is 1.17 with one optional operation, `readCiRun(repository, runId)` (a workflow run's status, conclusion, address, name and the jobs completed of all it lists; `null` is "could not ask"), which the GitHub plugin answers with `gh run view <id> --repo <repo> --json status,conclusion,url,name,jobs`. `src/ticket-mode/wait-on/` holds what the board needs to judge a declared wait and nothing is wired to a run yet: `wait-parse.ts` (the shape check of `waitingOn` and `until`), `wait-read.ts` (one read per kind of event: a fleet job through `fleet job status <id> --json`, a CI run and a pull request through the code host, a ticket through the tracker; an unreadable item is pending and never a failure), `wait-verdict.ts` (all finished, or any failed, with the words for each item) and `wait-text.ts` (the card line `Waiting on fleet job 123 (4 of 6 pages, about 20 min)` and the rounding of the time left).

Acceptance:

```bash
node --test plugins/github/ci-run.test.ts src/ticket-mode/wait-on/*.test.ts
AGENT_ORG_HOST="$AGENT_ORG_HOST" pnpm exec rstest run --config scripts/rstest/rstest.config.ts plugins/github/conformance.test.ts src/plugins/fakes/code-host.test.ts
npm run typecheck
gh run view "$(gh run list --repo a11ign/agent-org --limit 1 --json databaseId --jq '.[0].databaseId')" --repo a11ign/agent-org --json status,conclusion,url,name,jobs
```
