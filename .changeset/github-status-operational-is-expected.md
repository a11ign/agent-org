---
"agent-org": patch
---

The gate's per-tick `github-status: operational (call N ms).` reading (a11ign/a11ign#3723) is an expected repeating line: `repeating-lines.allowlist.json` names it, so the detector stops offering it to `orchestrator` after 30 ticks. Its other two states, `github-status: UNKNOWN (...)` and `GITHUB INCIDENT: ...`, stay offered.
