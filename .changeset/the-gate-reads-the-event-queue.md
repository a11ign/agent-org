---
"@a11ign/agent-org": patch
---

`src/event-queue.ts` reads the queue `event-receiver.ts` writes (a11ign/agent-org#979): events after a byte-offset cursor that moves only on `ackThrough`, a half-written last line left for the next read, and the pull requests, issues, commits and merge groups the events name. Nothing calls it yet, so no behaviour changes and `poll` stays the default.
