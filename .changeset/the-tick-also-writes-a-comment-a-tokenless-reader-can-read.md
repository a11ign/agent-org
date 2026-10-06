---
"agent-org": minor
---

The tick's last completion is also written to one standing COMMENT (a11ign/a11ign#3896), because the control plane's token has no scopes and GitHub answers it `403` for the Actions variable `GATE_LAST_TICK` while it reads every public object. `writeHeartbeat` now EDITS comment `HEARTBEAT_COMMENT_ID` on the closed issue a11ign/a11ign#3880 (authored by `a11ign-ai-workers`, the identity the work-tick unit runs as, since only the author may edit), so the comment's `updated_at` is the last completion on GitHub's own clock and `curl` reads it with no `Authorization` header. The body differs on every tick (`<!-- gate-heartbeat -->`, the epoch milliseconds and an ISO stamp): measured, an edit that changes nothing does NOT move `updated_at`. The variable write stays, and the two fail separately: a failed comment write says one `HEARTBEAT COMMENT NOT WRITTEN` line on stderr, never changes the tick's exit, and never creates a comment (a missing one fails loudly).
