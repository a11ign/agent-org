---
"agent-org": patch
---

`pr:open` run from another repository's worktree without `--repo` now says so on its Region refusal: it read the tree as the first repository's and refused the row's own paths in words that never named the flag, and the remedy it did print (`Outside-Region:` lines) led a session to write false statements into the PR body. The refusal names `--repo <repo>` when `origin` is a code repository the project declares. A Region path written with a trailing parenthetical (`agent-org:src/x.test.ts (new)`) is now read as the path, as `#3134` was filed.
