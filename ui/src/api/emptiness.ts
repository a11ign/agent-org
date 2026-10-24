import type { TicketsPageView, QueueView, WritersView } from "./types.ts";

/** `usePoll`'s `isEmpty` for the answers that are an object holding a list: nothing queued, no new-ticket request, no ticket on the page. */
export const queueIsEmpty = (queue: QueueView): boolean => queue.entries.length === 0;
export const writersAreEmpty = (writers: WritersView): boolean => writers.runs.length === 0;
export const ticketsPageIsEmpty = (page: TicketsPageView): boolean => page.tickets.length === 0;
