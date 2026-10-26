// @ts-check
// module: what the instance's two threads say to each other (A11-282) -- the board snapshot, a forwarded request and its answer, and the page's copies of tickets that travel with it
//
// THE BOARD THREAD OWNS THE QUEUE; THE REQUEST THREAD ONLY READS IT. The board thread (`board-thread.ts`) posts a snapshot of everything a read takes from the queue and the pool after
// every change and once a second, and the request thread (`request-thread.ts`) answers reads from the latest. Every other request is forwarded whole and answered by the board
// thread's own routes. Everything here is structured-cloned by `postMessage`: plain data, no functions.
//
// THE PAGE'S COPIES TRAVEL WITH A WRITE. A queue route queues "the page's copy of a ticket, else the tracker's" and keeps what the tracker said of a ticket it read again. Both threads
// keep copies (`known`), and the request thread's are the page's, since it answers the lists. So a forwarded request carries the request thread's copies of the tickets its body
// names, the board thread routes on them, and the answer carries back what the route left for those tickets.
import type { BlockingSite } from "./blocking-ledger.ts";
import type { Json } from "./local-http.ts";
import type { LoopReading } from "./loop-delay.ts";
import type { Queue } from "./queue/queue-entries-and-outcomes.ts";
import type { ReadPaths, UpdateView } from "./read-routes.ts";
import type { TicketSettings } from "./settings.ts";
import type { Ticket } from "./source.ts";
import type { Pool } from "./pool.ts";

/**
 * Everything a read takes from the board thread, as of `at` (ms since the epoch): the queue, the pool's readings, the terminal address (worked out on the board thread, so the
 * request thread never asks the exposure), the update, and the board thread's own loop reading and the spawns that held it.
 */
export type BoardSnapshot = Readonly<{
  queue: Queue;
  held: ReturnType<Pool["held"]> | null;
  pullReviews: Record<string, string>;
  claimWarning: string | null;
  hostAlerts: ReturnType<Pool["hostAlerts"]>;
  reviewerState: ReturnType<Pool["reviewerState"]> | null;
  terminal: string | null;
  update: UpdateView;
  loop: LoopReading;
  blocking: readonly BlockingSite[];
  at: number;
}>;

/** A board's copies of some tickets, and of their latest claims: null where it has none. */
export type KnownCopies = Readonly<{ tickets: readonly (readonly [string, Ticket | null])[]; claims: readonly (readonly [string, string | null])[] }>;

/** The copies of tickets and claims a board keeps (`ReadBoard.known`). */
export type Known = { tickets: Map<string, Ticket>; claims: Map<string, string> };

/** A request the request thread does not answer itself, forwarded whole. `query` is its search string. */
export type CallMessage = Readonly<{ kind: "call"; id: number; method: string; path: string; body: Json; query: string; known: KnownCopies }>;

/**
 * What the request thread tells the board thread: a forwarded request, that it listens, or that a read used the terminal address, which the board thread then works out again
 * (the exposure is asked when a page reads it, as it always was, and never while a read waits).
 */
export type ToBoard = CallMessage | Readonly<{ kind: "listening"; port: number }> | Readonly<{ kind: "terminal" }>;

/** The code a request thread exits with when it cannot listen (the port is taken): the instance then stops at once, as it did when it listened itself. */
export const LISTEN_FAILED = 3;

/**
 * What the board thread tells the request thread: a new snapshot, the answer to a forwarded request, or to stop. On `stop` the request thread ends, and its exit handler kills the checks it
 * started: a worker's exit handlers do not run when the instance exits, so without it a stopped instance would leave its checks running.
 */
export type ToRequests = Readonly<{ kind: "snapshot"; snapshot: BoardSnapshot }> | Readonly<{ kind: "answer"; id: number; status: number; value: unknown; known: KnownCopies }> | Readonly<{ kind: "stop" }>;

/** What a request thread's `workerData` says it is, so the module starts serving only in the worker `serve()` made. */
export const REQUEST_THREAD = "agent-org request thread";

/**
 * What the request thread starts with: the settings, the key, the files the reads open, the first snapshot, this instance's claimant, and the facts the Plugins and Settings reads
 * would otherwise run a program for, read once on the board thread: the tool's version as the Plugins section names it, and the release the plugins' contracts are checked against.
 * The claimant is read there too, since the first read of it writes the instance's id.
 */
export type RequestThreadData = Readonly<{
  role: typeof REQUEST_THREAD;
  settings: TicketSettings;
  claimant: string;
  key: string;
  paths: ReadPaths;
  snapshot: BoardSnapshot;
  toolVersion: string;
  agentOrgVersion: string | null;
}>;

/**
 * The tickets a request's body names, whose copies travel with it: its `keys`, its `key`, and that ticket's sub-issues the page holds a copy of, as the parent's copy lists them
 * or as their own copies name their parent, since Queue children queues the page's copy of each. PURE.
 */
export function namedKeys(body: Json, known: Pick<Known, "tickets">): string[] {
  const keys = Array.isArray(body.keys) ? body.keys.map(String) : [];
  const key = typeof body.key === "string" ? [body.key] : [];
  const listed = key.flatMap((parent) => known.tickets.get(parent)?.children ?? []);
  const children = [...known.tickets.values()].filter((ticket) => typeof ticket.parent === "string" && key.includes(ticket.parent)).map((ticket) => ticket.key);
  return [...new Set([...keys, ...key, ...listed, ...children])];
}

/** The copies `known` holds of `keys`, null for each it has none of. PURE. */
export function copiesOf(known: Known, keys: readonly string[]): KnownCopies {
  return { tickets: keys.map((key) => [key, known.tickets.get(key) ?? null] as const), claims: keys.map((key) => [key, known.claims.get(key) ?? null] as const) };
}

/** Puts `copies` in `known`: a copy replaces the board's own, and a null takes the board's away, so both boards hold the same for those tickets. */
export function applyCopies(known: Known, copies: KnownCopies): void {
  for (const [key, ticket] of copies.tickets) {
    if (ticket === null) known.tickets.delete(key);
    else known.tickets.set(key, ticket);
  }
  for (const [key, claimant] of copies.claims) {
    if (claimant === null) known.claims.delete(key);
    else known.claims.set(key, claimant);
  }
}
