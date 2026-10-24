---
"agent-org": patch
---

`ticket:ui` keeps the last good read of each SSH remote connection's page reads, with the time it was read, in memory and in a mode-600 file per connection under the state directory, so it survives a restart. When it cannot reach that remote (the tunnel, the instance or the key), its 502 "cannot reach" answer keeps the same sentence and adds `lastKnown: { value, readAt }` for a read it kept. Local and https connections, writes and "not JSON" answers keep nothing. The new Atomaut board shows it as the Instance unreachable view (A11-195).
