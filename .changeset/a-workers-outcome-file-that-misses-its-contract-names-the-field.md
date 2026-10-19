---
"agent-org": minor
---

A worker's outcome file that does not match its contract is refused at the Stop hook, which names the field the contract wants and what the file wrote in its place (`ready-pr needs prs: [{repo, url}], you wrote pr`), so the worker fixes it in the same turn. The pool reads `pr` as a string for one pull request, the near miss, and names the field in any other refusal instead of quoting the first 200 characters of the file. A finished run whose outcome file was unreadable is read again when the file changes, so a corrected file clears Needs you without a Dismiss. The worker brief shows one full example of each outcome kind it may write. A11-118.
