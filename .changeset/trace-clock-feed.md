---
"agent-org": patch
---

The trace store is the one source for "how long" on a row or pull request, and the outcome clock is held to it (a11ign/a11ign#3517, #3494's done-when 5). `src/trace/clock-feed.ts` is a pure read of the store's records (`clockFeedOf`: when a row was filed or a pull request opened, when the clock starts, when a merge or close stopped it; `openMsOf`), and `clock-feed.test.mjs` runs the gate's own facts into `overdueReading` beside it and is RED, naming both numbers, when the clock's `since` or the line it states is not the store's; the same join holds `org-retro`'s median open-to-merge and the backlog age to it. The clock is NOT fed from the store at run time (the gate does not ingest it each tick). The comparison found a real divergence, fixed here: a pull request's ISSUE record (`issues/{n}`) reads a second after its own `created_at`, so the store dated #3575 one second after the clock (1 of 40 merged pull requests); a pull request now asks `pulls/{n}`.
