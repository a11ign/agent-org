---
"@a11ign/agent-org": patch
---

A release dispatch that published clears the release-failure streak (a11ign/agent-org#1298). The publish check looked for a job named `release`, but a called workflow's jobs are named `release / <job>` (run 38332090768: `release / publish`), so no dispatch read as published, every release read as promote-only, and a release that shipped kept the earlier failure as the newest verdict. The check now matches `release / publish` with a `success` conclusion, and a promote-only dispatch, whose `release / publish` job is skipped, still reads as no verdict.
