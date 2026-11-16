---
"agent-org": patch
---

GitHub Issues as the tracker, end to end (A11-447, step 2 of 2). A ticket of GitHub Issues queued, worked and merged on fakes now ends closed, as a Linear ticket ends Done, and a test runs that on the fault-injection fixture instance with `github-issues` as its tracker. Core no longer assumes Linear in three places: a GitHub Issues host that still holds Linear's old `tickets.linearKey` no longer has it read as its tracker's key, and `agent-org doctor --fix` no longer offers to move it into a block that refuses it; the Pick view's empty list, its Assignee row and a run that ends on a ticket the tracker has none of say "the tracker" where they said "Linear"; and with no tracker enabled, the Plugins page offers `plugin enable linear` before `plugin install github-issues`.
