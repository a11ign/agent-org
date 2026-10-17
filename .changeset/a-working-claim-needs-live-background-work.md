---
"agent-org": minor
---

A worker may end its turn on `working` only while its session has live background work that will wake it: a background shell or a Monitor. The stop hook reads that from the session's transcript and refuses `working` with nothing running (`nothing is running that will wake you; wait in the foreground or arm a Monitor on the process`), and a transcript it cannot read is allowed out loud. The board reads the pane's status line (`· 1 shell, 1 monitor`): a run idle with no background work for three minutes is marked stalled `background work gone` and told once, `your background work is gone; check it and carry on`, instead of waiting thirty minutes. A11-31 started `pnpm fleet:patch` detached and wrote `working` with nothing to wake it, so it would have sat In progress until the thirty-minute stall flag, which only flags it. A detached process wakes nothing, so the worker brief now says to arm a Monitor on its PID or its log.
