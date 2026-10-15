---
"@a11ign/agent-org": patch
---

`src/pr-list-memory.ts` and `src/tick-scopes.ts` (new, not yet called) are the two things a narrowed pull-request read needs. `tick-scopes.ts` carries what a tick's events named to the gate (`readTickScopes` is `null` for a missing or half-written file and `[]` only for a tick that named nothing). `pr-list-memory.ts` remembers each repository's open-PR list with the instant it was read whole; `narrowedPrList` patches it with one `pr view` per named pull request (a `MERGED` or `CLOSED` one leaves, an `OPEN` one replaces or joins), makes no call for a repository no pull request scope names, and answers `whole` with a reason (`missing`, `unreadable`, `too-old`, `unnamed-scope`, `view-failed`) for every case it cannot patch. a11ign/agent-org#993, part of a11ign/a11ign#5043.
