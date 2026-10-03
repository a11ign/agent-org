---
"agent-org": patch
---

The `row-branch-unshipped` order no longer tells `product-manager` to "open its pull request" or "delete the branch" for a row whose branch already carries an OPEN pull request (the second closes it). It names the PR and the `claim --adopt=<previous holder>` route that finishes it, read off the open-PR list the tick already holds, so no API pool is spent. A branch with no open PR gets the order it always did. `claim`'s own refusal of a row whose branch is on `origin` (#2014) is unchanged.
