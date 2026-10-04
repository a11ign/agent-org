---
"agent-org": patch
---

The trunk-red order now tells the fixer how to make its fix findable (a11ign/a11ign#3449): label what it opens `incident` and put `Incident: incident:trunk-red` on a line of its own in the body, on both the own path (the fix pull request) and the routed path (the filed row). `readFixRow` accepts an open pull request carrying that label and line, where it skipped pull requests and so reported `nobody has picked this up yet` beside an open fix PR, and returns the item's `session:` label as `holder`. The other incident and stall keys have no standing order that opens a fix and are labelled by hand.
