---
"agent-org": patch
---

A killed tick's wake now says which phase it was in (a11ign/agent-org#1542). The start marker a tick writes names the phase it last began (`phase`) and when (`phaseAt`), and the marker is rewritten whole, through a temporary file and a rename, at each phase boundary, so the next tick never reads half of one. The killed-tick order says `It was in phase "<name>" for at most <m s>` and points the reader at that phase's journal first, then the cost lines. A marker an older tick wrote names no phase, and the order says so and keeps the advice it always had. A marker that cannot be written does not fail the tick: the first refusal is said once on stderr, and the killed-tick order then has no phase to name.
