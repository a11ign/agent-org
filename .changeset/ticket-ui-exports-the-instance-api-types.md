---
"agent-org": patch
---

The instance API's answers have named, exported types (A11-189), so the board UI's typed client (`ui/src/api/`) imports them and a server change that breaks the UI fails `tsc`: `ConfigView`, `QueueView`, `WritersView`, `TicketView`, `TicketsPageView`, `PickView`, `QueueChildrenView`, `ChoiceView` and `SavedChoice` from `ticket-mode/server.ts`, `ConnectionsView` from `ui-server.ts`, and `RunAction` from `board-view/pull-status-and-notes.ts`. Each is derived from the code that builds the answer. No route, status or answer changes: `/api/config` is built by a function of its own and `withTaken` is generic over the ticket it is given.
