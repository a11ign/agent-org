// @ts-check
// module: the tracker ticket mode reads -- one interface, so a second tracker is one new plugin and no change to the board or the pool
//
// THE INTERFACE LIVES IN THE TRACKER CONTRACT (`src/plugins/contracts/tracker.ts`, A11-158), and every name is re-exported here, so no caller changes. Beside the
// ticket port, not inside it: `src/ticket-port/port.ts` serves the gate, whose every read is synchronous; ticket mode needs two reads and a download, all
// asynchronous over HTTP. The tracker the board reads is the enabled tracker plugin's (`src/plugins/active.ts`); Linear (`plugins/linear`) is the first.
export type { TicketLabel, Ticket, Assignee, PullState, Keywords, Blocker, StateMove, AutomaticCompletionUndo, People, ScopePage, TicketSource, TicketText, TrackerWriting, TrackerProject, Priority, TicketComment, TicketComments } from "../plugins/contracts/tracker.ts";
export { DEFAULT_KEYWORDS, PRIORITIES } from "../plugins/contracts/tracker.ts";
