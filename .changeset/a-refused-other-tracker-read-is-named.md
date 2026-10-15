---
"@a11ign/agent-org": patch
---

The other-tracker un-park pass (a11ign/agent-org#5177) no longer skips a tracker whose open-row read was refused without a word: the tick's log names that tracker and says its parked rows stay parked this tick. The flag `rows.autoUnpark` is read only from the `machinery-canary.json` record, so a `rows.autoUnpark` key in a project's `project.json` does nothing; the comments now say so. Nothing is turned on by this change.
