---
"@a11ign/agent-org": minor
---

In `webhook` mode the tick's snapshot is moved by the event queue instead of by two ETag probes per repository: a repository an event names is re-read, every other is served from the cache, and a tick in which nothing happened makes no `gh` call in the snapshot step (agent-org#981, part of a11ign/a11ign#5043). A receiver whose heartbeat (`<queue>.alive`) is 120 s old or absent, or a queue that cannot be read, falls back to today's probes and the tick's line says `EVENTS UNHEALTHY`. `poll` stays the default and is byte-for-byte unchanged; the revert is `"source": "poll"` in `host.json`.
