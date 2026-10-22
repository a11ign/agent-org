// @ts-check
// module: the text of a ticket as a run was briefed with, and the hash that tells two readings of it apart (A11-167, ADR 0005)
//
// A TICKET READ is what a brief says it was written from: the description, when the tracker last changed the ticket, a hash of the description and when the board read it. The hash, not `updatedAt`,
// says the text changed: the tracker moves `updatedAt` on every state move and attachment the board itself makes, which would re-plan every ticket the board touches. `updatedAt` is recorded and shown,
// so a reviewer can find the version the work was done against.
import { createHash } from "node:crypto";
import type { Ticket } from "./source.ts";

/** A ticket as a run was briefed with it: `updatedAt` is null when the tracker does not say, and `readAt` is when the board read it (epoch milliseconds). */
export type TicketRead = Readonly<{ updatedAt: string | null; hash: string; description: string; readAt: number }>;

/**
 * The sha256 of a description, in hex, with line ends made `\n` and trailing whitespace trimmed, so a tracker that stores `\r\n` or a trailing newline does not make an unchanged description read as
 * changed. Every brief and every plan stamp hashes through this one function. PURE.
 */
export function descriptionHash(description: string): string {
  return createHash("sha256").update(description.replace(/\r\n/g, "\n").trimEnd()).digest("hex");
}

/** The read of `ticket` at `readAt`. PURE. */
export function ticketReadOf(ticket: Pick<Ticket, "description" | "updatedAt">, readAt: number): TicketRead {
  return { updatedAt: ticket.updatedAt ?? null, hash: descriptionHash(ticket.description), description: ticket.description, readAt };
}

/** Whether two readings hold the same description. PURE. */
export const sameDescription = (a: Pick<TicketRead, "hash">, b: Pick<TicketRead, "hash">): boolean => a.hash === b.hash;
