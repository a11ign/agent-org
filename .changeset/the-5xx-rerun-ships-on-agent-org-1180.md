---
"agent-org": patch
---

The 5xx rerun ships ON (`CI_RERUN_ON_5XX.enabled`, agent-org#1180 behind the switch row a11ign#5230). A required check that went red on a GitHub 5xx, with no later error, is rerun once by the tick. The explicit OFF passed as `flags` to `rerunRedOn5xx` is today's route.
