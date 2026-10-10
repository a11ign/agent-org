---
"agent-org": patch
---

A claim's stall clock starts at the later of the newest claim record and the newest `labeled` event of the holder's `session:<name>` label. A hand start adds the label and writes no record, so the clock started at the previous holder's record and a session started ten hours after it was nudged at its first tick, and released after the grace if it had not moved. The label's time is read through the existing `HostReads.labelEvents` seam, only for a claim whose record is older than the stall interval (a quiet org spends no call) and at most once per claim per tick. A label time that cannot be read keeps the record's time, never an earlier one, and the tick logs why. A claim made by `row-claim` reads as before. a11ign/agent-org#612.
