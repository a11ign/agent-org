// module: what the palette keeps in the browser (A11-387) -- the ticket handed over to the Tickets page, and the tickets recently opened from it
//
// THE HANDOFF IS ONE VALUE, READ ONCE. Opening a ticket from the palette writes it and loads Tickets, which takes it (reading clears it) and shows the ticket ticked. It expires, so a handoff
// a closed tab left behind is never acted on later. Recently opened keeps a snapshot of each row, since the search cannot read a ticket by its key.
import { inScope, type Person } from "../../../src/ticket-mode/assignee-filter.ts";
import { recalledJson, rememberedJson } from "../shell/storage.ts";
import type { Match, OpenTicket } from "./search-model.ts";

/** The names the palette keeps its values under. */
export const HANDOFF_MEMORY = "atomaut.search.handoff";
export const RECENT_MEMORY = "atomaut.search.recent";

/** How long a handoff waits for the Tickets page to take it, in ms. */
export const HANDOFF_TTL_MS = 60_000;
/** How many tickets Recently opened lists. */
export const RECENT_MAX = 3;
/** The event the palette sends when it hands a ticket over to the Tickets page it is already on, which takes it without loading the page again. */
export const HANDOFF_EVENT = "atomaut:search-handoff";

/** A ticket opened from the palette, and where the person was before: what the Tickets page ticks, says in its banner, and goes back to. */
export type Handoff = Readonly<{
  key: string;
  project: string | null;
  assignee: Person | null;
  /** The project and Assignee scope in effect before the jump, and what the scope is called on the page. */
  fromProject: string | null;
  fromScope: string;
  fromScopeName: string;
  /** When the handoff stops counting, in ms since the epoch. */
  expires: number;
}>;

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null;
const isPerson = (value: unknown): value is Person => isRecord(value) && typeof value.id === "string" && typeof value.name === "string";
const isNameOrNull = (value: unknown): value is string | null => value === null || typeof value === "string";

function isHandoff(value: unknown): value is Handoff {
  if (!isRecord(value)) return false;
  return typeof value.key === "string" && isNameOrNull(value.project) && (value.assignee === null || isPerson(value.assignee)) && isNameOrNull(value.fromProject)
    && typeof value.fromScope === "string" && typeof value.fromScopeName === "string" && typeof value.expires === "number";
}

/** Keeps `handoff` for the Tickets page: why the browser refused it, or null once it is kept. */
export const handOver = (storage: Storage | null, handoff: Handoff): string | null => rememberedJson(storage, HANDOFF_MEMORY, handoff);

/**
 * What the Tickets page finds handed over: nothing (none kept, or one that expired), a ticket, the reason what is kept cannot be read, or that the browser refuses its storage. Refused storage
 * is told apart from an unreadable handoff: no handoff can have been written there, and the palette said so when its write was refused.
 */
export type HandoffRead = Readonly<{ kind: "none" }> | Readonly<{ kind: "refused" }> | Readonly<{ kind: "handoff"; handoff: Handoff }> | Readonly<{ kind: "unreadable"; reason: string }>;

/** Why a kept handoff is not one. */
export const NOT_A_HANDOFF = "what search handed over is not a ticket this page can read";

/** The handoff waiting for the Tickets page, cleared as it is read. */
export function takeHandoff(storage: Storage | null, now: number): HandoffRead {
  if (storage === null) return { kind: "refused" };
  const kept = recalledJson(storage, HANDOFF_MEMORY);
  if (kept.kind === "absent") return { kind: "none" };
  // Cleared whatever it holds, so it is acted on once; a clear the browser refuses leaves it to expire.
  rememberedJson(storage, HANDOFF_MEMORY, null);
  if (kept.kind === "unreadable") return kept;
  if (!isHandoff(kept.value)) return { kind: "unreadable", reason: NOT_A_HANDOFF };
  return kept.value.expires > now ? { kind: "handoff", handoff: kept.value } : { kind: "none" };
}

/** Whether the scope the person came from would have listed the ticket. */
export const wasInScope = (handoff: Handoff, viewer: Person | null): boolean => inScope({ key: handoff.key, assignee: handoff.assignee }, handoff.fromScope, viewer);

const isOpenTicket = (value: unknown): value is OpenTicket =>
  isRecord(value) && typeof value.key === "string" && typeof value.title === "string" && typeof value.status === "string" && isNameOrNull(value.project) && (value.assignee === null || isPerson(value.assignee));

const isRecent = (value: unknown): value is Omit<Match, "run"> =>
  isRecord(value) && typeof value.key === "string" && typeof value.title === "string" && (value.ticket === null || isOpenTicket(value.ticket));

/** The tickets recently opened from the palette, newest first, and why the list kept could not be read (or null): any row it could read is still listed. */
export type Recent = Readonly<{ matches: Match[]; unreadable: string | null }>;

/** Why a kept Recently opened list is not one. */
export const NOT_RECENT = "what this browser kept of Recently opened is not a list of tickets";

/** The tickets recently opened from the palette, newest first, without their runs: the palette reads each one's run from the queue as it is now. */
export function recentOf(storage: Storage | null): Recent {
  const kept = recalledJson(storage, RECENT_MEMORY);
  if (kept.kind === "absent") return { matches: [], unreadable: null };
  if (kept.kind === "unreadable") return { matches: [], unreadable: kept.reason };
  const rows: unknown[] = Array.isArray(kept.value) ? kept.value : [];
  const readable = rows.filter(isRecent);
  const matches = readable.slice(0, RECENT_MAX).map((recent) => ({ key: recent.key, title: recent.title, ticket: recent.ticket, run: null }));
  return { matches, unreadable: Array.isArray(kept.value) && readable.length === rows.length ? null : NOT_RECENT };
}

/** The fields of a ticket a remembered row keeps. */
const snapshotOf = (ticket: OpenTicket | null): OpenTicket | null => ticket === null ? null : {
  key: ticket.key, title: ticket.title, project: ticket.project, assignee: ticket.assignee ?? null, labels: ticket.labels ?? [], status: ticket.status, statusOrder: ticket.statusOrder, priority: ticket.priority,
  ...(ticket.statusType === undefined ? {} : { statusType: ticket.statusType }),
};

/**
 * Puts `match` first in Recently opened, once, keeping the newest `RECENT_MAX`: why the browser refused it, or null. Rows of a list that cannot be read are replaced, so the list is readable
 * again from here on.
 */
export function rememberOpened(storage: Storage | null, match: Match): string | null {
  const others = recentOf(storage).matches.filter(({ key }) => key !== match.key);
  const recent = [{ key: match.key, title: match.title, ticket: snapshotOf(match.ticket) }, ...others.map(({ key, title, ticket }) => ({ key, title, ticket }))];
  return rememberedJson(storage, RECENT_MEMORY, recent.slice(0, RECENT_MAX));
}
