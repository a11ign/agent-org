---
"agent-org": patch
---

The gate reads the holds of pull requests in the declared repositories beside the first. `orgHealthNow` was handed `prs`, the first repository's own list, and the keyed repositories' open pull requests (`pullRequestsOfOthers(otherScopes)`, tagged `repoKey`/`repo`) never reached the wait read, so a keyed pull request's `hold:*` with a TRUE `Waiting-for: merged` was neither lifted (#3479) nor ordered: agent-org#401 stood 77 minutes after its blocker merged. They now arrive as `keyedPrsRead` and feed the wait read only; every other reading (red, overdue, idle) is still about the first repository. a11ign/a11ign#4189.
