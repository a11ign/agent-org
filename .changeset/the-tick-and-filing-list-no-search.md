---
"@a11ign/agent-org": patch
---

The tick's wake and the filing tool no longer list rows through GitHub SEARCH (a11ign/a11ign#5074, the two measured spenders left after #5050). `wake.ts`'s stuck-cause row reads (the open `answer:ceo` rows, the open parked rows, and the title's rows for the re-ask) are `repository.issues(labels:)` connections through `readRowsByLabel`, and `row-file.ts`'s duplicate-title check is a plain list of the newest 200 open rows compared by title, both under `readUnlessRefused`'s one refusal memory. The price, said in both files: a twin of an open row older than the window is not seen where the search saw it. `src/packaging/no-search-reads.test.ts` now walks `wake.ts` and `row-file.ts`.
