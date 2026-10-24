---
"agent-org": patch
---

A run's queue entry now carries the numbered steps of its plan (`plannedSteps: [{ n, title }]`, read from the plan files when the run starts), the step it is on (`currentStep`) and where it ran (`worker: { instance, host }`), for the Run detail page (A11-219, step 1 of 2). A worker whose plan has numbered steps is told to write `currentStep` in its outcome file as it moves on, and the board reads it while the agent works; the outcome file accepts `currentStep` on every kind and refuses anything but a whole number of 1 or more. `/api/queue` sends all three.
