---
"agent-org": patch
---

A fleet box that differs from the pins manifest reaches the chairman's announcement channel (A11-205). A fifth incident source, `incident:fleet-drift`, reads `runs/fleet-drift-mirror.json`, the mirror `fleet-watch` writes of control's hourly `fleet:drift` record. It is open while the record lists a difference (or says the manifest could not be read) and names the boxes and the fields (`Windows`, `Edge`, `NVDA`, `Worker code`), never an address. Its `firstSeenAt` is the record's own start of the run, so the core's 30-minute hold-down counts from when the box began to differ, and it resolves, with one "cleared", when the record lists none. A missing mirror, a record the hourly check never wrote, and a mirror or a record more than two hours old read `cannot-ask`: no event, never a clear. `createReaders` takes a `fleetDriftPath`, which the host wiring points at `runs/fleet-drift-mirror.json` beside the fleet-watch state file.
