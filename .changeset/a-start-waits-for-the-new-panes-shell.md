---
"agent-org": patch
---

A ticket run's start waits for its new pane's shell instead of failing the run. herdr refuses `agent start` with `agent_pane_busy` until the pane's shell is at its prompt, and the pool started the agent about 0.2 seconds after it created the workspace. On a loaded host the shell was not ready in time, the start failed, and the run was marked `crashed` with its workspace closed (VE-48 and VE-68, 2026-10-20). A start refused with `agent_pane_busy` is now tried again every 500 ms, up to 30 tries, in the same workspace. Any other refusal fails at once, as before, and a pane that never comes up still fails the run after about 15 seconds.
