---
"agent-org": patch
---

`ownerOfPr` has an `owner-gone` rung between `dependency-bot` and `ceo`: a pull request whose `session:` label names an ENDED session and whose every named row is closed is owned by `product-manager` (`DEAD_OWNER_FALLBACK`), not the `ceo` rung. It is a real rung, so `unresolvedOwnerEvents` does not record it as `owner-unresolved`. `pr-owners.ts` puts the fact `closingRowsClosed` on the PR beside `labelEnded` (false for an empty open-rows read or a PR naming no row), so `ownerOfPr` stays pure, and the shared-file order words the owner-gone seat as such. a11ign/a11ign#4644.
