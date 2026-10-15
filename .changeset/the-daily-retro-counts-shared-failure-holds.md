---
"@a11ign/agent-org": patch
---

The daily retro counts two things nothing counted before (a11ign/agent-org#997, split from #5098): red pull requests the gate held as a shared failure and then released, read from the tick journal's `ci-shared-failure: holding …` and `ci-shared-failure: released …` lines, and `ci-shared-failure` incident rows closed as "not the same failure", read from their closing comments. A pull request counts once per window, and its release counts only when its hold began inside the window. Each count above 0 files an incident through `recordFailures` in `dailyRetrospective`, one per pull request (per UTC day of release) and one per closed row. A count nobody could read (the journal, or the closed-row read refused, at its 500-row ceiling, or missing comments past its first page) reads `unknown`, never 0.
