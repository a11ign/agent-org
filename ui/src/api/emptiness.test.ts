import { queueIsEmpty, ticketsPageIsEmpty, writersAreEmpty } from "./emptiness.ts";
import type { QueueView, TicketsPageView, WritersView } from "./types.ts";

// The answers' other fields are not what emptiness reads, so these are the parts of each that it does.
const queueOf = (entries: unknown[]) => ({ entries }) as unknown as QueueView;
const writersOf = (runs: unknown[]) => ({ runs }) as unknown as WritersView;
const pageOf = (tickets: unknown[]) => ({ tickets, next: null }) as unknown as TicketsPageView;

describe("emptiness", () => {
  it("calls a queue with no entries empty and one with an entry not", () => {
    expect(queueIsEmpty(queueOf([]))).toBe(true);
    expect(queueIsEmpty(queueOf([{}]))).toBe(false);
  });

  it("calls an answer with no new-ticket runs empty and one with a run not", () => {
    expect(writersAreEmpty(writersOf([]))).toBe(true);
    expect(writersAreEmpty(writersOf([{}]))).toBe(false);
  });

  it("calls a page with no tickets empty and one with a ticket not", () => {
    expect(ticketsPageIsEmpty(pageOf([]))).toBe(true);
    expect(ticketsPageIsEmpty(pageOf([{}]))).toBe(false);
  });
});
