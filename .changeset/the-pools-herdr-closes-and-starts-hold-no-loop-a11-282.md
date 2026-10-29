---
"agent-org": patch
---

The board thread no longer holds its loop for the `herdr` calls a run's start and end make. The close of an ended run's workspace (250 ms to 1 s, its result dropped at every call site) and a start's pane, agent listing and close on failure go through an asynchronous call that carries herdr's own refusal (`ctx.herdrCall`, over `herdrRunAsync`), so the board's figure "synchronous holds an hour" no longer counts them. The pass's fill and every start wait for the closes that are out, so a run queued again never opens a workspace beside the one it replaces and a listing never reads a workspace that is closing, and an instance that ends waits for them for up to five seconds.
