---
"agent-org": patch
---

The Linux service unit writes `WorkingDirectory=` unquoted, as systemd requires. The quoted path was refused as "not absolute", so `agent-org start instance` wrote a unit that never started (agent-org#1712). `ExecStart=`, `Environment=` and the launchd plist are unchanged.
