---
"@a11ign/agent-org": patch
---

row-file's filing preflight reads the open pull requests and open rows over REST, not GraphQL (a11ign/agent-org#1005, a11ign#4777). `prOpenTimes` in the sweep window, the blast-radius gate's open-row read and the duplicate-row check now call `gh api repos/<repo>/pulls` and `repos/<repo>/issues` with `state=open`, 100 to a page, and spend the core pool instead of the GraphQL pool that the managers App shares. One helper, `openRestListing`, pages the listing and drops pull requests from the issues listing; a listing still open after 100 pages throws, so each caller reads it as unknown and says so.
