---
"agent-org": patch
---

A worker or seat pane that `crash-recover` resumes after an unclean boot now has `AGENT_ORG_HOST` set: the resume command types `AGENT_ORG_HOST=<host declaration path> claude --resume ...`, so a pane started again after a crash has the host declaration the spawn gave the first one (agent-org#1484).
