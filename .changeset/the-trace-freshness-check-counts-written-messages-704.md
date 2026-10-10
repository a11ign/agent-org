---
"agent-org": patch
---

The trace-freshness check counts a session as working only when it WROTE a message inside the window, not when its transcript file was merely touched (a11ign/agent-org#704). A session that has finished its last message still rewrites its `last-prompt` and `cost-state` lines, which carry no timestamp and no message, so its file moved while it produced no turn and raised three false `metrics-outage` incidents on 2026-10-10 (a11ign/a11ign#928). `sessionsWorking` now reads the newest `assistant`/`user` line's own timestamp (a Codex rollout's `response_item`) from the transcript's tail; a root that cannot be read still throws. `freshnessLine` says "a message was written in the last 10 minutes". `STALE_AFTER_MS`, the episode rules and the order text are unchanged.
