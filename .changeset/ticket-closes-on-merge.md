---
"agent-org": minor
---

A ticket worker's pull request now names its ticket with the tracker's closing keyword (`Closes <KEY>` for Linear) when it completes the ticket, and with the non-closing one (`Refs <KEY>`) plus a `Partial: <what remains>` line when it is partial. `pr:open` refuses a body that links its ticket only with the non-closing keyword unless it says the pull request is partial, so a completed ticket no longer stays In Progress after its pull request merges. The board also completes the ticket itself when a completing run's pull request merges and its body did not, and says so on the ticket. The brief, `pr:open` and the board read the tracker's keywords through the ticket source, with `Closes` and `Refs` as the default. A11-92.
