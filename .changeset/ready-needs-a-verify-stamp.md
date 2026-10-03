---
"agent-org": minor
---

A pull request is marked ready only on a green verify stamp for its head (a11ign/a11ign#3215). `pr:open` refuses a create WITHOUT `--draft` when the project's `verify --check` is not green for this head and this body, naming the reasons and the command that makes it green; a draft opens on a passing body alone. The gate's `gh pr ready` after a `convinced` verdict is withheld on the same reading, and the author (not `product-manager`) is told once per patch. The stamp is read through the project's own script, never re-run: a project declares verify by having a `verify` script in `package.json`, and answers `--check [--draft-body=<file>]` with exit 0 or 1 and `  - <reason>` lines. **A project with no `verify` script is not refused**, and `pr:open` says `no verify declared for <name>`. `main` takes the reading as a `verifyStamp` dependency wired in the entry block, so a caller of `main` is unchanged.
