---
"agent-org": patch
---

The machinery canary's `blind-ticks` counts only the lanes the gate refused. A repository the gate skipped by design (paced below the pool's reserve, or not named by an event) is still named on the PARTIAL line, but no longer samples as a blind tick, so switching pacing on no longer raises the counter that says the org is blind. a11ign/agent-org#1329.
