---
"agent-org": patch
---

The gate compares each claimed row's live `## Region` and `## Acceptance` with the `Claimed-scope:` hash its claim record holds, and orders `product-manager` (one order per row and live hash, a digest line) to file the added scope as its own row and return the claimed row's text to what was claimed. A never-claimed row, a claim made before the line existed, an unchanged row, prose outside the two sections and a refused read are never ordered. `scopeHash` and the reader of the line move to the leaf `src/claim-scope.ts` (re-exported by `row-claim.ts`), so a tick can read them without importing the claim; the new `org-health` class is `scope-added-mid-row`. a11ign/a11ign#4759.
