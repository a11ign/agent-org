---
"agent-org": minor
---

A ticket-mode worker that ends a turn while its own background work is still running (a shell, a Monitor or a task that will wake it) writes `{ "kind": "working", "reason": "..." }` instead of `needs-human` (A11-80). The Stop hook accepts it once, and refuses a later stop on the same file so a woken worker says how the run stands. The pool keeps the run running, holding its slot, with the reason as its latest note; the outcome it writes next replaces the note and ends the run as usual, and a parked run that writes `working` is live again. A run idle with no newer outcome for the new `tickets.stallMinutes` (default 30, refused by name unless a whole number of 1 or more) is marked Stalled on the board, without being ended or prompted. The worker brief says to use `working` only while its own background work is genuinely running, never to park a question.
