---
"@a11ign/agent-org": patch
---

`blocker-cleared` no longer types an order for a row of another tracker whose open pull request closes it by that tracker's own reference (`Closes owner/repo#N`). The reference is read against the row's own tracker, so the holder is no longer asked to pick up work that is already in review. A bare `#N` counts only when the pull request is in the same repository as the row; a bare `#N` in a pull request of another repository no longer resumes the primary row `#N`.
