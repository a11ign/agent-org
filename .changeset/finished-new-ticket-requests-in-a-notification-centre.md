---
"agent-org": minor
---

Finished new-ticket requests move off the Tickets page into a notification centre behind a bell in the sidebar's head, on every page (A11-383). The panel lists each Done and Failed request with the tickets it filed or why it failed, filters them (All, Succeeded, Failed), and clears them one at a time or all at once. A request that finishes while the page is open opens the panel, marked New, without taking the focus. Requests still under way keep their card on Tickets, which no longer has a Dismiss button. The board polls its requests once for every page, and `POST /api/writer/dismiss-finished` clears every finished request in one write.
