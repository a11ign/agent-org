---
"agent-org": patch
---

`request-thread-load.test.ts` no longer fails the suite at random. Its throwaway instance was sent SIGTERM and not waited for, so an instance still shutting down could write its `state` directory after the test's private TMPDIR check, which failed the whole shard. Stopping a child process is now one helper, `stopChild` (`src/lib/stop-child.ts`): SIGTERM, SIGKILL after a grace period, resolved once the process has exited. The throwaway instance and `ticket:capture`'s processes both stop through it, and `ticket:capture` now waits for a killed process to be gone before it cleans up.
