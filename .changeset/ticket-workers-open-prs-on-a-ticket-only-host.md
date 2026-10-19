---
"agent-org": patch
---

A ticket worker's `pr:open` runs on a machine that declares no project. A host file with `tickets` and no `primary` made every worker's `pr:open` refuse with "host.json has no primary field", so no ticket pull request opened since v0.232.0 made `pr:open` the workers' route. A run with `AGENT_ORG_TICKET` set on such a host now loads with no project, board or tracker, and asks for no `.acceptance/` file or acceptance report, because no project's CI reads one. Its Region, changeset and `Closes` checks are unchanged, and a host that declares a `primary` is unchanged. `pr:open` also takes its diff against the branch `origin/HEAD` names rather than `origin/main`, so a repository whose default branch is `develop` can be checked.
