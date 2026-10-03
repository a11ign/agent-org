---
"agent-org": minor
---

`agent-org dora` measures the four DORA metrics (deployment frequency, lead time for changes, change failure rate, time to restore) for each repository the project declares, from the npm registry or a repository's GitHub Releases, its merged pull requests, its `regression` rows and git ancestry, and never from the org's own state. The daily retrospective carries the block and trends each number against the previous reading. A source that cannot be read is `unknown`, a metric with nothing to measure is `undefined`, and neither is ever 0. `.agent-org/project.json` gains an optional `dora` list (`repo`, `release: { kind: "npm", package } | { kind: "tag" }`, `releasablePaths`).
