// @ts-check
// module: the tracker ticket mode reads -- one interface, so a second tracker is one new file and no change to the board or the pool
//
// THE INTERFACE LIVES IN THE TRACKER CONTRACT (`src/plugins/contracts/tracker.ts`, A11-158), and every name is re-exported here, so no caller changes. Beside the
// ticket port, not inside it: `src/ticket-port/port.ts` serves the gate, whose every read is synchronous; ticket mode needs two reads and a download, all
// asynchronous over HTTP. Linear (`linear.ts`) is the first source.
export type { TicketLabel, Ticket, Assignee, PullState, Keywords, Blocker, StateMove, People, ScopePage, TicketSource } from "../plugins/contracts/tracker.ts";
import type { Keywords } from "../plugins/contracts/tracker.ts";

/** The keywords of a source that names none: the two Linear reads, so a source that needs no others is briefed with them. */
export const DEFAULT_KEYWORDS: Keywords = Object.freeze({ closing: "Closes", nonClosing: "Refs" });
