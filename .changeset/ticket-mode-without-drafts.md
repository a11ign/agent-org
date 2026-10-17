---
"agent-org": minor
---

Ticket mode can open pull requests ready for review instead of as drafts, and can start the gate's reviewer on them.

- `tickets.drafts: false` makes a worker open each of its pull requests ready (no `--draft`). Its run is Awaiting review with no Approve, and is watched for feedback as a run Ready to merge is. The hook allows a non-draft `gh pr create` only for a run in this mode. Absent or `true` is unchanged.
- `tickets.reviewer: "atomic"` starts the gate's codex reviewer on each ready head of a watched run's pull request, in the tickets' herdr session, once per head. It posts as `a11ign-reviewer`. A not-convinced verdict resumes the same worker for a feedback round, up to 3. A pull request whose author is outside the org gets no reviewer.
- A `tickets.drafts` or `tickets.reviewer` value of the wrong shape refuses the board's start, naming the setting.
- Both flags are documented beside the other `tickets.*` settings in the README, with canary signals and revert.
