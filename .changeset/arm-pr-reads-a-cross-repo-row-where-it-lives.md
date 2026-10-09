---
"agent-org": patch
---

`arm-pr` reads a closed row's labels from the repository the row lives in. `labelArmedPr` and `labelsWanted` asked the PR's own repository, so an `a11ign/agent-org` PR closing `a11ign/a11ign#4386` printed `Could not resolve to an issue` and was armed without the row's `session:` label. Both now read `closedRowReferences(prBody, repo)` through one `readRowLabels`, and a bare `Closes #n` still reads the PR's own repository. a11ign/a11ign#4426.
