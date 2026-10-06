---
"agent-org": patch
---

A test that spawns `wake.mjs` as a process no longer waits the real five-second `/clear` settle. `wake.mjs` reads `AGENT_ORG_TEST_SETTLE_MS` for the blocking sleep behind the settle; the spawning tests set it to `0`. It is absent in production (no file under `host/` names it, pinned in `wake.test.ts`), it can only shorten the wait (a larger or malformed value is ignored), and `CLEAR_SETTLE_MS` stays `5_000` with the two `THE DEFAULT IS REAL` tests unchanged. Eleven spawning tests across five files each paid one real wait, about 55 s of test wall in all; measured before and after on the same machine. a11ign/a11ign#3769.
