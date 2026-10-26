---
"agent-org": patch
---

An update restart no longer ends a run that is still starting as `crashed` (A11-294). A run the board restarted on while it was `starting`, or `running` with no herdr workspace on record, and that herdr does not list, is put back on the queue with the same round (its `review`, `feedback` and `asked`) and starts again; its log says a restart queued it again, and it carries no "lost in a restart" mark. A run that had an agent open is lost and queued again as before. `agent-org update` also holds the restart of the instance until no run is `starting`, for at most two minutes, polling every five seconds, and says so when the wait ran out.
