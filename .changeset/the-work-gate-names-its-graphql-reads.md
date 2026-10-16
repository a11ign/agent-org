---
"agent-org": patch
---

A `gh api graphql` call is now recorded in the `gh` call ledger with the name of the read it made (`api graphql repository.issue.closedByPullRequestsReferences`: the operation's own name, else the path of the query's first selection), so `api-pool-low` and `node src/gh-ledger.ts <ledger> --by-query [--since <iso>] [--until <iso>]` say which read spends the pool and not only `api graphql` (agent-org#1618). A ledger line written before this still reads. An un-park refused because the tick had spent its GraphQL budget is no longer asked again on the next tick: the row waits 15 minutes (kept in `unpark-deferred.json` in the state directory) and the log says `DEFERRED unpark #n`; a refusal for any other reason is still `COULD NOT unpark` and is asked again.
