---
"agent-org": patch
---

A per-row Claude engineer launches with `--autocompact 200000`, not `300000` (a11ign/a11ign#4180, #4055 next wave item 1). `MIN_WORKING_ROOM_TOKENS` in `src/worker-profile.mjs` moves from 200,000 to 100,000 and the window, which is derived, lands as 35,000 margin + 65,000 base + 100,000. The headroom guard's floor in `worker-profile.test.ts` moves from 150,000 to 100,000 with it, 4.5 times the ~22k that thrashed in #2717. A literal pin now says the pane form carries 200000. The headless form and the managers' windows are unchanged.
