// @ts-check
// module: an eval set (A11-431) -- the merged tickets a worker eval replays, read from a checked-in JSON list and refused by name when one is malformed
//
// A SET IS A JSON LIST of `{ repo, ticket, baseSha, mergedPr }`: the repository the ticket's work landed in (`owner/name`), the ticket's key, the commit the worker starts from (the
// merged pull request's base) and the pull request whose diff the worker's is scored against. An optional `test` is the shell command that says whether the worker's tree passes;
// without one the entry's tree is checked with `DEFAULT_TEST`.
//
// AT MOST TEN TICKETS (the epic's eval spend, A11-429 Q4): a longer list is refused, never cut, so a set that ran is the set that was checked in.

/** One ticket of a set. */
export type EvalEntry = Readonly<{ repo: string; ticket: string; baseSha: string; mergedPr: number; test?: string }>;

/** The most tickets one set may hold (A11-429, Q4). */
export const MAX_SET_SIZE = 10;

/** The check a worker's tree is held to when its entry names none: agent-org's own (`AGENTS.md`), on a fresh install. */
export const DEFAULT_TEST = "pnpm install --frozen-lockfile && pnpm run check:changed";

const REPO = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const TICKET = /^[A-Za-z][A-Za-z0-9]*-\d+$/;
const SHA = /^[0-9a-f]{40}$/;

/** What a field of an entry must be, and how it is told. */
const FIELDS: Readonly<Record<"repo" | "ticket" | "baseSha" | "mergedPr", { valid: (value: unknown) => boolean; wants: string }>> = {
  repo: { valid: (value) => typeof value === "string" && REPO.test(value), wants: "owner/name" },
  ticket: { valid: (value) => typeof value === "string" && TICKET.test(value), wants: "a ticket key such as A11-431" },
  baseSha: { valid: (value) => typeof value === "string" && SHA.test(value), wants: "a full commit sha, 40 lowercase hex (git fetches a commit only by its full name)" },
  mergedPr: { valid: (value) => Number.isInteger(value) && (value as number) > 0, wants: "a pull request number" },
};

/** One entry, or a throw naming its position and the field that is wrong. PURE. */
function entryOf(value: unknown, at: number): EvalEntry {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error(`entry ${at + 1} is not an object`);
  const record = value as Record<string, unknown>;
  for (const [field, { valid, wants }] of Object.entries(FIELDS)) {
    if (!valid(record[field])) throw new Error(`entry ${at + 1}'s ${field} is ${JSON.stringify(record[field])}, and wants ${wants}`);
  }
  if (record.test !== undefined && (typeof record.test !== "string" || record.test.trim() === "")) throw new Error(`entry ${at + 1}'s test is not a command`);
  const { repo, ticket, baseSha, mergedPr, test } = record as EvalEntry;
  return { repo, ticket, baseSha, mergedPr, ...(test === undefined ? {} : { test }) };
}

/**
 * The entries of a set's JSON text. THROWS naming what is wrong: text that is not JSON, a value that is not a list, an empty list, more than `MAX_SET_SIZE` entries, a malformed
 * entry, or a ticket listed twice (its two results would be one row of the table). PURE.
 */
export function parseSet(text: string): readonly EvalEntry[] {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch (error) {
    throw new Error(`the set is not JSON (${(error as Error).message})`);
  }
  if (!Array.isArray(value)) throw new Error("the set is not a JSON list");
  if (value.length === 0) throw new Error("the set is empty");
  if (value.length > MAX_SET_SIZE) throw new Error(`the set holds ${value.length} tickets, and a set holds at most ${MAX_SET_SIZE}`);
  const entries = value.map(entryOf);
  const seen = new Set<string>();
  for (const { ticket } of entries) {
    if (seen.has(ticket)) throw new Error(`${ticket} is listed twice`);
    seen.add(ticket);
  }
  return entries;
}
