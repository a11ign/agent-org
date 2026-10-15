---
"@a11ign/agent-org": patch
---

Org health has a signal for a fleet that stays on mixed Windows builds: `fleet-build-mixed-over-4h`. An OPEN `incident` issue in a11ign/a11ign whose body carries `Incident: incident:fleet-build-mixed` on a line of its own, and that has stood open four hours or more, offers `ceo` an order naming the incident, its box count and its age. A refused read of the open incidents is a stated unknown, never a clear. The reader is `readFleetBuildIncidents` (one REST call on the core pool) and the reading is `fleetBuildMixedReading`; the tick takes the answer as `facts.fleetBuildIncident`. a11ign/agent-org#943.
