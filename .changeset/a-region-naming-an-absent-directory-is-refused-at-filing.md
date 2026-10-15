---
"@a11ign/agent-org": patch
---

A `--ready` row whose `## Region` names a directory its repository does not have is refused at filing (a11ign/agent-org#855). Each path in the Region is checked against `origin/main` of the repository the entry builds in, so a row that names `packages/guards/...` in a repository with no `packages/` stops at filing and names the repository that does have it. A keyed path (`nvda-worker:packages/...`) is checked against that key's own clone. A single new top-level file is not checked. An entry whose clone is not declared on this host, or is not on this host's disk, is not checked.
