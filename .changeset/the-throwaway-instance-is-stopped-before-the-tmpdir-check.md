---
"agent-org": patch
---

`request-thread-load.test.ts` no longer fails the suite at random. Its throwaway instance was sent SIGTERM and not waited for, so an instance still shutting down could write its `state` directory after the test's private TMPDIR check, which failed the whole shard. `stop()` now resolves once the instance has exited (SIGKILL after ten seconds), and the test awaits it. Test-only: no shipped behaviour changes.
