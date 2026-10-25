// @ts-check
// module: a finished run's copy of its ticket's description, moved on when the ticket changed (A11-250) -- PURE
//
// A RUN THAT HOLDS A BLOCKED PULL REQUEST KEEPS ITS TICKET'S DESCRIPTION, and the reviewer's brief reads the ticket's decisions from it (`briefOf`). A person who edits the ticket's Decisions in the tracker after the
// review is seen by reading the description again; this records it, and changes nothing else: the run is not briefed against the new text, and it is not marked stale.
import { replace, type Queue } from "./queue-entries-and-outcomes.ts";

/** Record `description` as the text of ticket `key` in the copy its run holds. A key not on the queue, or a description the run already holds, changes nothing. */
export function ticketTextRead(queue: Queue, key: string, description: string): Queue {
  return replace(queue, key, (entry) => (entry.ticket.description === description ? entry : { ...entry, ticket: { ...entry.ticket, description } }));
}
