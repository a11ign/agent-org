---
"agent-org": patch
---

`tick-cost.jsonl` keeps at least a day of ticks. The cap it is cut past rises from 2 MiB to 4 MiB, so the newest half it keeps is 2 MiB: about 800 ticks and 30 hours at the rate the readback measured (about 26 an hour, about 2.5 KiB each). The half it kept before, 1 MiB, held about 400 ticks and 15 hours, so the tick-wall readback (agent-org#1210) could not read 24 hours from it (agent-org#1379).
