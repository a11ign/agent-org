---
"agent-org": patch
---

A ticket labelled `board-reliability` names one figure of `GET /api/health` and a threshold in a `Figure:` line of its `## Done-when` (`synchronous holds under 10 an hour`, `Linear failures under 1%`, `loop lag p99 under 100 ms`, each optionally `, for 7d`). The board watches the figure from the release that carries the fix, for the ticket's window, and when a reading reaches the threshold it reopens the ticket once with the readings and queues it on the saved default model and effort. A11-282 and A11-345 are held to figures of their own, `doctor` lists each open reliability ticket with its current figure, and a ticket labelled `board-reliability` with no `Figure:` line is a doctor warning (A11-366).
