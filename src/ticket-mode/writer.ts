// @ts-check
// module: a ticket writer's drafts -- the draft files a writer run leaves, read and checked strictly, and the ticket text each one makes
//
// THE BOARD OWNS THE DRAFT FORMAT. The ticket-writing skill is outside this repository and its unattended mode plans existing tickets, so the
// writer's brief (`worker-files.ts`) tells the run the one JSON shape the board reads, and this module checks it. A draft is refused BY NAME AND
// FIELD (`02-wire.json: "priority" must be one of ...`), and a malformed draft never discards the good ones beside it: the caller shows the
// refusals and keeps the rest. Nothing here reads the tracker to decide a draft is valid, except to resolve the duplicates a draft names, and
// nothing here creates a ticket: `writer-create.ts` does, on a person's approval.
import { randomUUID } from "node:crypto";
import { existsSync, lstatSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { Ticket } from "./source.ts";

/** The folder under a writer run's folder where the run leaves its drafts, one JSON file each. */
export const DRAFT_DIR = "drafts";
/** The most draft files one writer run may leave; the rest are refused by name. */
export const MAX_DRAFTS = 10;
/** The largest draft file that is read. */
export const MAX_DRAFT_BYTES = 200_000;
/** The priorities a draft may name, most urgent first. */
export const PRIORITIES = ["urgent", "high", "medium", "low", "none"] as const;
export type Priority = (typeof PRIORITIES)[number];
/** Linear's number for each priority: 0 is none, 1 the most urgent. */
export const PRIORITY_NUMBER: Readonly<Record<Priority, number>> = Object.freeze({ urgent: 1, high: 2, medium: 3, low: 4, none: 0 });

/** A ticket's key, such as `A11-12`. */
const TICKET_KEY = /^[A-Za-z][A-Za-z0-9]*-\d+$/;
/** A reference to another draft of the same request, by its file's name without `.json`: `draft:02-wire`. */
const DRAFT_REF = /^draft:([\w.-]+)$/;
const TITLE_CHARS = 255;
const TEAM_KEY = /^[A-Za-z][A-Za-z0-9]*$/;

/** A ticket a draft says it duplicates: the key it names and why. */
export type Duplicate = Readonly<{ key: string; why: string }>;

/** One draft, as it is checked: every field present, with the defaults a draft leaves out. */
export type Draft = Readonly<{
  title: string;
  why: string;
  doneWhen: readonly string[];
  notes: string | null;
  team: string | null;
  project: string | null;
  repo: string | null;
  goal: string | null;
  labels: readonly string[];
  priority: Priority;
  /** A ticket's key, or `draft:<stem>` for a draft of the same request. */
  parent: string | null;
  blocks: readonly string[];
  blockedBy: readonly string[];
  duplicates: readonly Duplicate[];
}>;

/** A duplicate as the board shows it: its title and address when the tracker has the ticket, or null for "not found in the tracker". */
export type ResolvedDuplicate = Readonly<{ key: string; why: string; title: string | null; url: string | null }>;

/** A draft file the board refused, by its name, and why. */
export type Rejection = Readonly<{ file: string; reason: string }>;

/** What one writer run's folder holds: its drafts that are valid, and the files refused. */
export type DraftRead = Readonly<{ drafts: readonly Readonly<{ file: string; draft: Draft }>[]; rejected: readonly Rejection[] }>;

/** The fields a draft may hold, and nothing else: an unknown one is refused by name, so a typo is not silently dropped. */
const FIELDS: ReadonlySet<string> = new Set(["title", "why", "doneWhen", "notes", "team", "project", "repo", "goal", "labels", "priority", "parent", "blocks", "blockedBy", "duplicates"]);

/** A draft that fails the check, naming the file and, when one field is at fault, the field. */
export class DraftRefusal extends Error {
  readonly file: string;
  readonly field: string | null;
  constructor(file: string, field: string | null, reason: string) {
    super(field === null ? `${file}: ${reason}` : `${file}: "${field}" ${reason}`);
    this.file = file;
    this.field = field;
  }
}

const isObject = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
const nonEmpty = (value: unknown): value is string => typeof value === "string" && value.trim() !== "";

/** The stem of a draft file's name: its name without `.json`, which is how another draft names it. */
export const stemOf = (file: string): string => file.replace(/\.json$/, "");

/** A key a draft may name: a ticket's own key, or a draft of this request by `draft:<stem>`. */
function keyOrDraft(value: unknown, field: string, file: string, stems: ReadonlySet<string> | null, own: string): string {
  if (typeof value !== "string") throw new DraftRefusal(file, field, `must be a ticket key, such as A11-12, or draft:<file name without .json>, not ${JSON.stringify(value)}`);
  if (TICKET_KEY.test(value)) return value;
  const ref = DRAFT_REF.exec(value);
  if (ref === null) throw new DraftRefusal(file, field, `must be a ticket key, such as A11-12, or draft:<file name without .json>, not ${JSON.stringify(value)}`);
  if (ref[1] === own) throw new DraftRefusal(file, field, `names this draft itself, ${value}`);
  if (stems !== null && !stems.has(ref[1])) throw new DraftRefusal(file, field, `names ${value}, which is not a draft of this request`);
  return value;
}

function listOf<T>(value: unknown, field: string, file: string, item: (entry: unknown, index: number) => T): T[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new DraftRefusal(file, field, "must be a list");
  return value.map((entry, index) => item(entry, index));
}

function optionalText(value: unknown, field: string, file: string): string | null {
  if (value === undefined || value === null) return null;
  if (!nonEmpty(value)) throw new DraftRefusal(file, field, "must be a non-empty string, or left out");
  return value;
}

/**
 * One draft, checked: the object a draft file holds, named by `file`. `repos` are the repositories on this machine, which `repo` must name; `stems`
 * are the other drafts of the request, which `parent`, `blocks` and `blockedBy` may name (null while the request's drafts are not all known). Throws a
 * {@link DraftRefusal} naming the field. PURE.
 */
export function draftFrom(file: string, value: unknown, repos: readonly string[], stems: ReadonlySet<string> | null = null): Draft {
  if (!isObject(value)) throw new DraftRefusal(file, null, "must be a JSON object");
  const unknown = Object.keys(value).find((key) => !FIELDS.has(key));
  if (unknown !== undefined) throw new DraftRefusal(file, unknown, `is not a draft field: the fields are ${[...FIELDS].join(", ")}`);
  const own = stemOf(file);
  const title = value.title;
  if (!nonEmpty(title) || title.length > TITLE_CHARS || title.includes("\n")) throw new DraftRefusal(file, "title", `must be one line of 1 to ${TITLE_CHARS} characters`);
  if (!nonEmpty(value.why)) throw new DraftRefusal(file, "why", "must be a non-empty string");
  const doneWhen = value.doneWhen;
  if (!Array.isArray(doneWhen) || doneWhen.length === 0 || !doneWhen.every(nonEmpty)) {
    throw new DraftRefusal(file, "doneWhen", "must be a non-empty list of non-empty strings, one per item that finishes the ticket");
  }
  const team = optionalText(value.team, "team", file);
  if (team !== null && !TEAM_KEY.test(team)) throw new DraftRefusal(file, "team", `must be a team's key, such as A11, not ${JSON.stringify(team)}`);
  const repo = optionalText(value.repo, "repo", file);
  if (repo !== null && !repos.includes(repo)) throw new DraftRefusal(file, "repo", `must be one of the repositories on this machine: ${repos.join(", ")}`);
  const priority = value.priority ?? "none";
  if (typeof priority !== "string" || !(PRIORITIES as readonly string[]).includes(priority)) {
    throw new DraftRefusal(file, "priority", `must be one of ${PRIORITIES.join(", ")}, not ${JSON.stringify(priority)}`);
  }
  const labels = listOf(value.labels, "labels", file, (entry) => {
    if (!nonEmpty(entry)) throw new DraftRefusal(file, "labels", "must be a list of non-empty label names");
    return entry;
  });
  const duplicates = listOf(value.duplicates, "duplicates", file, (entry) => {
    const isDuplicateEntry = (candidate: unknown): candidate is { key: string; why: string } => isObject(candidate) && typeof candidate.key === "string"
      && TICKET_KEY.test(candidate.key) && typeof candidate.why === "string" && nonEmpty(candidate.why);
    if (!isDuplicateEntry(entry)) {
      throw new DraftRefusal(file, "duplicates", `must be a list of { "key": "<ticket key>", "why": "<why it is the same>" }, not ${JSON.stringify(entry)}`);
    }
    return { key: entry.key, why: entry.why };
  });
  return Object.freeze({
    title,
    why: value.why,
    doneWhen: Object.freeze([...doneWhen]),
    notes: optionalText(value.notes, "notes", file),
    team: team?.toUpperCase() ?? null,
    project: optionalText(value.project, "project", file),
    repo,
    goal: optionalText(value.goal, "goal", file),
    labels: Object.freeze(labels),
    priority: priority as Priority,
    parent: value.parent === undefined || value.parent === null ? null : keyOrDraft(value.parent, "parent", file, stems, own),
    blocks: Object.freeze(listOf(value.blocks, "blocks", file, (entry) => keyOrDraft(entry, "blocks", file, stems, own))),
    blockedBy: Object.freeze(listOf(value.blockedBy, "blockedBy", file, (entry) => keyOrDraft(entry, "blockedBy", file, stems, own))),
    duplicates: Object.freeze(duplicates),
  });
}

/** The ticket's text in the house shape: why, what finishes it, the repository it is for, then any notes. PURE. */
export function descriptionOf(draft: Draft): string {
  const lines = [`**Why:** ${draft.why}`, "", "**Done when:**", "", ...draft.doneWhen.map((item) => `* ${item}`)];
  if (draft.repo !== null) lines.push("", `**Repository:** ${draft.repo}`);
  if (draft.notes !== null) lines.push("", draft.notes);
  return `${lines.join("\n")}\n`;
}

/**
 * Read the draft files a writer run left in `dir`'s drafts folder. Each file is refused by name when it is not a plain `.json` file, is larger than
 * {@link MAX_DRAFT_BYTES}, is not JSON, or fails {@link draftFrom}; more than {@link MAX_DRAFTS} files refuses the rest. A draft that names another
 * draft by a stem no file has is refused too. The valid drafts and the refusals are each in file-name order.
 */
export function readDrafts(dir: string, repos: readonly string[]): DraftRead {
  const folder = join(dir, DRAFT_DIR);
  if (!existsSync(folder)) return { drafts: [], rejected: [] };
  const names = readdirSync(folder).sort();
  const rejected: Rejection[] = [];
  const candidates: { file: string; text: string }[] = [];
  names.forEach((file, index) => {
    if (index >= MAX_DRAFTS) {
      rejected.push({ file, reason: `${file}: more than ${MAX_DRAFTS} drafts, so this one is not read` });
      return;
    }
    const path = join(folder, file);
    const stat = lstatSync(path);
    if (!file.endsWith(".json") || !stat.isFile()) {
      rejected.push({ file, reason: `${file}: a draft is a plain .json file, not a link, a folder or another kind of file` });
      return;
    }
    if (stat.size > MAX_DRAFT_BYTES) {
      rejected.push({ file, reason: `${file}: a draft is at most ${MAX_DRAFT_BYTES / 1000} KB` });
      return;
    }
    candidates.push({ file, text: readFileSync(path, "utf8") });
  });
  const stems = new Set(candidates.map(({ file }) => stemOf(file)));
  const drafts: { file: string; draft: Draft }[] = [];
  for (const { file, text } of candidates) {
    try {
      drafts.push({ file, draft: draftFrom(file, parseJson(file, text), repos, stems) });
    } catch (err) {
      if (!(err instanceof DraftRefusal)) throw err;
      rejected.push({ file, reason: err.message });
    }
  }
  return { drafts, rejected: rejected.sort((a, b) => (a.file < b.file ? -1 : 1)) };
}

function parseJson(file: string, text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    throw new DraftRefusal(file, null, "is not valid JSON");
  }
}

/**
 * A draft's identity, stored on the board: a fresh UUID, which the tracker takes as the ticket's own id, so a creation that is retried after a restart
 * makes no second ticket. Random, so it is the one thing here that is not pure.
 */
export const newDraftId = (): string => randomUUID();

/** The duplicates of a draft, each read from the tracker: its title and address, or null where the tracker has no ticket by that key. */
export async function resolveDuplicates(duplicates: readonly Duplicate[], read: (key: string) => Promise<Ticket | null>): Promise<ResolvedDuplicate[]> {
  return Promise.all(duplicates.map(async ({ key, why }) => {
    const found = await read(key).catch(() => null);
    return { key, why, title: found?.title ?? null, url: found?.url ?? null };
  }));
}

/** How a writer run's outcome file says it ended: its drafts are written, or it asks the person a question in its terminal (grill only). */
export type WriterOutcome = Readonly<{ kind: "drafted" } | { kind: "needs-human"; reason: string }>;

/**
 * A writer run's outcome, from its file's text: `drafted`, or `needs-human` with the question. Anything else, or text that is not JSON, is the failure
 * the caller shows, named. PURE.
 */
export function parseWriterOutcome(text: string): WriterOutcome | string {
  let outcome: unknown;
  try {
    outcome = JSON.parse(text);
  } catch {
    return "its outcome is not valid JSON";
  }
  if (!isObject(outcome) || typeof outcome.kind !== "string") return "its outcome names no kind";
  if (outcome.kind === "drafted") return { kind: "drafted" };
  if (outcome.kind === "needs-human" && nonEmpty(outcome.reason)) return { kind: "needs-human", reason: outcome.reason };
  if (outcome.kind === "needs-human") return "its needs-human outcome gives no reason";
  return `it wrote the outcome ${JSON.stringify(outcome.kind)}, which a new-ticket run cannot end on`;
}
