Refs A11-245

Step 1 of 2 (agent-org): the reads, with no behaviour change to a run. The code host contract is 1.17 with one optional operation, `readCiRun(repository, runId)` (a workflow run's status, conclusion, address, name and the jobs completed of all it lists; `null` is "could not ask"), which the GitHub plugin answers with `gh run view <id> --repo <repo> --json status,conclusion,url,name,jobs`. `src/ticket-mode/wait-on/` holds what the board needs to judge a declared wait and nothing is wired to a run yet: `wait-parse.ts` (the shape check of `waitingOn` and `until`), `wait-read.ts` (one read per kind of event: a fleet job through `fleet job status <id> --json`, a CI run and a pull request through the code host, a ticket through the tracker; an unreadable item is pending and never a failure), `wait-verdict.ts` (all finished, or any failed, with the words for each item) and `wait-text.ts` (the card line `Waiting on fleet job 123 (4 of 6 pages, about 20 min)` and the rounding of the time left).

Acceptance:

```bash
node --test plugins/github/ci-run.test.ts src/ticket-mode/wait-on/*.test.ts
# rstest needs a fixture project (as CI's suite job lays one) and a writable private-tmp root, so neither depends on the caller's home; both are removed after
work="$(mktemp -d)"
cp -r src/packaging/fixtures/project-tree/. "$work/project"
sed -i "s|@@PROJECT@@|$work/project|" "$work/project/.agent-org/host.json"
git -C "$work/project" init -q
git -C "$work/project" add -A
git -C "$work/project" -c user.name=fixture -c user.email=fixture@example.invalid commit -q -m fixture
AGENT_ORG_HOST="$work/project/.agent-org/host.json" A11Y_PRIVATE_TMP_BASE="$work/tmp" node_modules/.bin/rstest run --config scripts/rstest/rstest.config.ts plugins/github/conformance.test.ts src/plugins/fakes/code-host.test.ts
rm -rf "${work:?}"
npm run typecheck
gh run view "$(gh run list --repo a11ign/agent-org --limit 1 --json databaseId --jq '.[0].databaseId')" --repo a11ign/agent-org --json status,conclusion,url,name,jobs
```
