// @ts-check
// THE TICKET PORT (ADR 0046, a11ign/a11ign#4510; agent-org#484, Phase 0 of #4505): THE TYPES, AND NOTHING ELSE.
//
// This file holds interfaces and the vocabulary they speak. It imports NOTHING -- not the adapter, not a `node:` module -- and it names no
// command of the tracker's own CLI, so an adapter for another tracker re-implements the table in ADR 0046 decision 5 and no consumer. The
// source test beside it (`ticket-port.test.ts`) holds both properties: no import of an adapter, and no spawn of the tracker's CLI.
//
// FOUR OPERATIONS, NO MORE (decision 1). A fifth needs a ruling from `ceo`. `TicketPort` below is exactly those four. What is NOT one of
// them is `OpenItemsReader`, at the foot of this file, and it says why it is separate.
//
// THE CODE HOST IS A SEPARATE PORT (decision 3). `CodeHostPort` is declared here as a TYPE only; its adapter is built by the first row that
// calls it (agent-org#488). Neither port refers to the other: a ticket holds a `ChangeRef`, and that is all it knows of a change.
//
// EVERY READ IS SYNCHRONOUS because the gate that consumes it is (`run: (args) => string` all the way down). A tracker whose adapter must
// be asynchronous is a ruling for `ceo`, not a thing to paper over here.

/** One item of a tracker: `scope` is whatever groups its items there (a repository, a team), `id` is its number inside it. */
export type ItemRef = Readonly<{ tracker: string; scope: string; id: number }>;

/** A change on the code host, `{ host, id }`, the only thing a ticket knows of one (decision 3). */
export type ChangeRef = Readonly<{ host: string; id: string }>;

/** The port's own state set (decision 1). `done` is reached by a change landing, so `changeState` records it and never closes anything. */
export type TicketState = "backlog" | "ready" | "in-progress" | "in-review" | "done" | "parked";

/** The named flags (decision 1). `answer-owed:<session>` and `lane:<owner>` carry their argument after the colon. */
export type TicketFlag = "priority" | "chairman-priority" | "hold" | "out-of-release" | `answer-owed:${string}` | `lane:${string}`;

/** What a tracker may tell a subscriber (decision 1). Level-triggered: an event is a hint to read again, never the fact. */
export type PortEventKind = "item-opened" | "state-changed" | "flag-added" | "flag-removed" | "blocker-resolved" | "decision-posted";

/** One thing that happened to an item. `actor` is who did it (decision 2), `null` only when the tracker does not say. */
export type ItemEvent = Readonly<{ at: string; actor: string | null; kind: PortEventKind; detail?: string }>;

/** What an item waits on, as data (decision 5): `notBefore` is an ISO date or instant, `waitingFor` each condition as it was written. */
export type ItemRelations = Readonly<{
  blockedBy: readonly ItemRef[];
  parent: ItemRef | null;
  children: readonly ItemRef[];
  linkedChanges: readonly ChangeRef[];
  notBefore: string | null;
  waitingFor: readonly string[];
}>;

/**
 * An item as `readItem` returns it.
 *
 * `state` IS `null` WHEN THE ITEM CARRIES NONE of the six, which is a fact about the item and is not `backlog`. `flags` holds each flag once.
 * `events` is the recent tail, oldest first.
 */
export type TicketItem = Readonly<{
  ref: ItemRef;
  title: string;
  body: string;
  state: TicketState | null;
  flags: readonly TicketFlag[];
  relations: ItemRelations;
  events: readonly ItemEvent[];
}>;

/** What `postDecision` is given. `role` and `runId` are written into a fixed header by the adapter, so who decided is on every decision (Move 0). */
export type Decision = Readonly<{ role: string; runId: string; kind: string; text: string }>;

/** What `changeState` is given. Every field is optional and an empty change is a no-op that reports `false`. */
export type StateChange = Readonly<{ state?: TicketState; addFlags?: readonly TicketFlag[]; removeFlags?: readonly TicketFlag[] }>;

/** A port-level event, as a subscriber receives it. */
export type PortEvent = Readonly<{ kind: PortEventKind; ref: ItemRef; at: string; actor: string | null }>;

/** Which events a subscriber wants: those of these kinds (any when omitted) about this item (any when omitted). */
export type EventFilter = Readonly<{ kinds?: readonly PortEventKind[]; ref?: ItemRef }>;

/** The four operations of the ticket port, and no others (ADR 0046 decision 1). */
export interface TicketPort {
  /** The item, or `null` when it could not be read. `null` MEANS COULD NOT ASK and never "there is no such item": a caller must not act on it. */
  readItem(ref: ItemRef): TicketItem | null;
  /** Posts ONE comment carrying the role and run in a fixed header, and returns the comment's id. Throws when it could not be posted. */
  postDecision(ref: ItemRef, decision: Decision): string;
  /**
   * ONE call, atomic from the caller's side and idempotent: returns whether anything changed, and `false` without writing when the item already
   * is as asked. The adapter orders the writes it needs. Throws when the item could not be read or written.
   */
  changeState(ref: ItemRef, change: StateChange): boolean;
  /** Registers `handler` for the events `filter` names and returns the function that cancels it. A handler re-reads the item and acts only if the gap is still there. */
  subscribe(filter: EventFilter, handler: (event: PortEvent) => void): () => void;
}

// --- the code host: a TYPE only (decision 3); agent-org#488 builds the first adapter, for the operations it uses ------------------------

/** What a change is waiting on: a verdict on one check run, and the head that run was for. */
export type ChangeCheck = Readonly<{ name: string; state: "passed" | "failed" | "pending"; head: string }>;
/** One review, WITH THE HEAD IT WAS POSTED ON, so a reader can tell a review of this head from one of an earlier head. */
export type ChangeReview = Readonly<{ actor: string; verdict: "approved" | "changes-requested" | "commented"; head: string; at: string }>;

export type ChangeFacts = Readonly<{
  ref: ChangeRef;
  head: string;
  checks: readonly ChangeCheck[];
  reviews: readonly ChangeReview[];
  merge: Readonly<{ state: "open" | "merged" | "closed"; armed: boolean; mergeable: boolean | null }>;
}>;

export type CodeHostEventKind = "head-moved" | "checks-settled" | "review-posted";
export type CodeHostEvent = Readonly<{ kind: CodeHostEventKind; ref: ChangeRef; at: string; actor: string | null }>;

/** The code host's port: read a change, request a review, arm the merge, and be told when the head moves, the checks settle or a review lands. */
export interface CodeHostPort {
  /** `null` MEANS COULD NOT ASK, as for `TicketPort.readItem`. */
  readChange(ref: ChangeRef): ChangeFacts | null;
  /** Asks `reviewer` to review. Throws when the request could not be made. */
  requestReview(ref: ChangeRef, reviewer: string): void;
  /** Arms the merge and returns whether it is armed now. Throws when it could not be asked. */
  armMerge(ref: ChangeRef): boolean;
  subscribe(filter: Readonly<{ kinds?: readonly CodeHostEventKind[]; ref?: ChangeRef }>, handler: (event: CodeHostEvent) => void): () => void;
}

// --- what is NOT one of the four ----------------------------------------------------------------------------------------------------

/** The request budget a tracker told us about while answering: what is left of it and when it comes back. A reading, never a guess. */
export type ApiBudget = Readonly<{ account: string | null; resource: string; remaining: number; limit: number; resetAt: string | null }>;

/** One open item as `OpenItemsReader` returns it: only what a consumer that asks "which rows are off the board" needs. `onBoard` is TRI-STATE, `null` for "could not tell". */
export type OpenItemSummary = Readonly<{ ref: ItemRef; title: string; openedAtMs: number; onBoard: boolean | null }>;

/**
 * EVERY OPEN ITEM'S BOARD MEMBERSHIP IN ONE READ, and it is deliberately NOT a method of `TicketPort`.
 *
 * `readRowsOffBoard` asks one question of every open row each tick. Through `readItem` that is one call per row, against the one call per 100
 * rows it makes today (agent-org#485's inventory is the baseline), and ADR 0046's own falsifier 3 is a port read that costs more calls per tick
 * than the read it replaced. So this is the first operation read in bulk. WHETHER IT IS A FIFTH OPERATION OR A FORM OF `readItem` IS `ceo`'s
 * TO RULE (it is named on agent-org#484), and until then it is a separate type so the four above stay a ceiling a reader can see.
 *
 * `null` MEANS COULD NOT ASK, NEVER "NOTHING IS OFF THE BOARD" (#1286): a refused read, an answer carrying errors and a list still paging at the
 * adapter's cap are all `null`. `onBudget` receives the request budget the answer named, once, so a tick learns its budget from the read it was
 * making; a refused read calls it never.
 */
export interface OpenItemsReader {
  readOpenItems(options?: { onBudget?: (budget: ApiBudget) => void }): OpenItemSummary[] | null;
}
