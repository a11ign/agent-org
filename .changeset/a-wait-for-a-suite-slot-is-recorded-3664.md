---
"agent-org": patch
---

A run that had to wait for a suite slot leaves a record that outlives it (a11ign/a11ign#3664, found reading #3608). `src/suite-slots.mjs` printed `all N slots ... are held; waiting for one` to the waiter's own stderr and kept nothing, so nobody could read afterwards whether a third contender ever queued. When a waiting run gets its slot it now appends ONE tab-separated line to `waits.log` in the slot directory (`~/.cache/agent-org/suite-slots/waits.log`): ISO time, waiter pid, cwd, milliseconds waited, slot, label. A run that took a free slot first time writes nothing; a record that cannot be written is said on stderr and the suite still runs. A waiter killed while still waiting writes nothing (the line is written on acquire). Three cases are pinned in `suite-slots.test.ts`: three contenders against two slots find exactly one record, naming the third; one contender, and two against two, find none.
