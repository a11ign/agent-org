---
"agent-org": patch
---

The tick's version banner (`agent-org vX.Y.Z (<sha>)` and `agent-org vX.Y.Z`, a11ign/a11ign#3443) is an expected repeating line: `repeating-lines.allowlist.json` names it, so the detector stops offering it to `orchestrator` after 30 ticks (a11ign/a11ign#3497). The banner's fault forms, `agent-org (at no release tag: <sha>)` and `agent-org (version unreadable: ...)`, stay offered.
