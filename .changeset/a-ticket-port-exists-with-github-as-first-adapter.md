---
"agent-org": patch
---

A ticket port exists, and one consumer calls through it (Phase 0 of a11ign/a11ign#4505, ADR 0046). `src/ticket-port/port.ts` is the interface (`readItem`, `postDecision`, `changeState`, `subscribe`, and a `CodeHostPort` type) and names no GitHub command; `src/ticket-port/github-adapter.ts` implements it, so the labels-as-state mapping is one table in one file. The open-rows-off-the-board read of the tick (`readRowsOffBoard`) asks the tracker through the adapter, with the same calls and the same answers. No behaviour changes. agent-org#484.
