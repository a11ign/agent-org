---
"agent-org": patch
---

The gate reads the NEWEST comments of a claimed row, not only the first 100. `gh issue list --json comments` returns a row's first 100 comments, oldest first, and says nothing about the rest, so on a row with more the claim-stall pass took an old claim record for the newest and read an already-merged pull request as "merged after the claim": #3566's claim was released twice within two minutes each time. A row that comes back at the cap is now re-read from its end in ONE batched GraphQL call for all such rows (`comments(last: 100)`, handed on in the same oldest-first shape); a tick with no row at the cap makes no extra call. A capped row whose end cannot be read is left out of the page, so the claim-stall pass skips it instead of releasing it. a11ign/a11ign#3821.
