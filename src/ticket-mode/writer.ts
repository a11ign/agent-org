// @ts-check
// module: a new-ticket run's outcome, and the record of the tickets it created -- read and checked strictly
//
// THE WRITER FILES ITS OWN TICKETS (A11-135). The create-ticket skill runs inside the writer run: it creates each ticket with the tracker's create tool
// and attaches its plan with the attachment tools. `hook.ts` allows exactly those calls and refuses any update. Each creation's key is written to the
// record beside the outcome file by the PostToolUse hook, as the creation returns, so the board can check the outcome's keys against what the run
// really made. Nothing here creates a ticket, and nothing here reads the tracker.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { TrackerWriting } from "../plugins/contracts/tracker.ts";

export { PRIORITIES, type Priority } from "../plugins/contracts/tracker.ts";

/** The file beside a writer run's outcome where the PostToolUse hook records each ticket the run created, one JSON line each. Only the hook writes it. */
export const CREATED_FILE = "created-issues.jsonl";
/** The file a Grill run writes its answers to, beside its outcome: the sections the board writes into the ticket (A11-134). */
export const DECISIONS_FILE = "decisions.md";
export { MAX_CREATED } from "./writer-limits.ts";

/** A ticket's key, such as `A11-12`. */
const TICKET_KEY = /^[A-Za-z][A-Za-z0-9]*-\d+$/;
/** The longest reason a run's outcome may give. */
const REASON_CHARS = 2000;

/** How a writer run's outcome file says it ended: the keys it created, for a run that cannot finish why, or, for a Grill run, the ticket it answered (A11-134). */
export type WriterOutcome = Readonly<{ kind: "created"; created: readonly string[] }
  | { kind: "needs-human"; reason: string; created: readonly string[] }
  | { kind: "decided"; ticket: string; created: readonly string[] }>;

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** The keys an outcome names, each a ticket key, or the reason it is not one. PURE. */
function keysIn(value: unknown): string[] | string {
  if (value === undefined) return [];
  if (!Array.isArray(value)) return "its created list is not a list of ticket keys";
  const bad = value.find((key) => typeof key !== "string" || !TICKET_KEY.test(key));
  return bad === undefined ? [...value] : `its created list names ${JSON.stringify(bad)}, which is not a ticket key such as A11-12`;
}

/**
 * A writer run's outcome, from its file's text: `created` with the keys it made, or `needs-human` with the reason and any keys it made before it stopped.
 * Anything else, or text that is not JSON, is the failure the caller shows, named. PURE.
 */
export function parseWriterOutcome(text: string): WriterOutcome | string {
  let outcome: unknown;
  try {
    outcome = JSON.parse(text);
  } catch {
    return "its outcome is not valid JSON";
  }
  if (!isObject(outcome) || typeof outcome.kind !== "string") return "its outcome names no kind";
  const keys = keysIn(outcome.created);
  if (typeof keys === "string") return keys;
  if (outcome.kind === "created") {
    return keys.length === 0 ? "its created outcome names no ticket: a run that made none ends needs-human, with its reason" : { kind: "created", created: keys };
  }
  if (outcome.kind === "needs-human" && typeof outcome.reason === "string" && outcome.reason.trim() !== "") {
    return { kind: "needs-human", reason: outcome.reason.slice(0, REASON_CHARS), created: keys };
  }
  if (outcome.kind === "needs-human") return "its needs-human outcome gives no reason";
  if (outcome.kind === "decided") {
    return typeof outcome.ticket === "string" && TICKET_KEY.test(outcome.ticket) ? { kind: "decided", ticket: outcome.ticket, created: keys }
      : "its decided outcome names no ticket key, such as A11-12";
  }
  return `it wrote the outcome ${JSON.stringify(outcome.kind)}, which a new-ticket run cannot end on`;
}

/**
 * The key a creation's result names, from the result the tracker's tool returned: its JSON text, found in a content block or the result itself, with the ticket
 * under the tracker's wrapper field when it names one, and the first of its fields that is a ticket key (`identifier`, or failing that `id`, for Linear's own tools,
 * which answer with the key as `id`). Null when the result names none. `shape` is the tracker plugin's `createdKey` (`TrackerWriting`). PURE.
 */
export function createdKeyOf(response: unknown, shape: TrackerWriting["createdKey"]): string | null {
  for (const text of textsOf(response)) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      continue;
    }
    const wrapped = shape.wrapper !== null && isObject(parsed) ? parsed[shape.wrapper] : undefined;
    const issue = isObject(wrapped) ? wrapped : parsed;
    if (!isObject(issue)) continue;
    const key = shape.fields.map((field) => issue[field]).find((candidate) => typeof candidate === "string" && TICKET_KEY.test(candidate));
    if (typeof key === "string") return key;
  }
  return null;
}

/** The text a tool's result carries, in whichever shape the hook is given: a string, content blocks, or an object. */
function textsOf(response: unknown): string[] {
  if (typeof response === "string") return [response];
  if (Array.isArray(response)) return response.flatMap(textsOf);
  if (isObject(response)) {
    if (typeof response.text === "string") return [response.text];
    if ("content" in response) return textsOf(response.content);
    return [JSON.stringify(response)];
  }
  return [];
}

/** The record's line for a created ticket: its key, as one JSON object on one line. PURE. */
export const createdLine = (key: string): string => `${JSON.stringify({ identifier: key })}\n`;

/**
 * The keys a writer run's record names, in the order it made them, or null when the record cannot be read: a record that is missing is no keys, and
 * one the board cannot read names none it can trust. PURE over the text it is given.
 */
export function createdKeysOf(text: string): string[] | null {
  const keys: string[] = [];
  for (const line of text.split("\n").filter((entry) => entry !== "")) {
    let entry: unknown;
    try {
      entry = JSON.parse(line);
    } catch {
      return null;
    }
    if (!isObject(entry) || typeof entry.identifier !== "string" || !TICKET_KEY.test(entry.identifier)) return null;
    keys.push(entry.identifier);
  }
  return keys;
}

/** The keys a writer run's folder records as created: none when nothing was, or null when the record cannot be read. */
export function readCreatedKeys(dir: string, read: (path: string) => string = (path) => readFileSync(path, "utf8")): string[] | null {
  const file = join(dir, CREATED_FILE);
  if (!existsSync(file)) return [];
  try {
    return createdKeysOf(read(file));
  } catch {
    return null;
  }
}
