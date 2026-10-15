---
"agent-org": patch
---

The machinery canary reads an hour the account pause held Claude work as no baseline. `machineryCanaryTick` marks each sample it takes while `gate.accountLimitPause` holds an active pause (read the way `pausedNow` reads it), and `signalReading` reads an hour BEFORE a flag's switch-on that holds such a sample as `unknown`, with a detail that names the pause, rather than as a surge over zeros (a11ign#5497). A flag whose every signal is `unknown` at the end of its hour stays `watching`, and is not `passed`. A pause that begins inside the hour a flag watches is still read, so a real regression is still reverted. The pause is written out in `org-health.ts` rather than imported from `account-limit.ts`, because that import breaks the messaging tools' import graph (agent-org#1425).
