// @ts-check
// UNTIERED READY ROWS: the `ready` rows that have made no tier decision, as a NUMBER in the daily retrospective (a11ign/agent-org#466; epic a11ign/a11ign#4437, move 4).
//
// The chairman's direction of 2026-10-09 08:45Z said every mechanical row with a machine-checkable Acceptance is `tier:haiku`, "including rows already ready and not yet
// claimed". Eighty minutes later Haiku had run zero turns in the hour and four of about forty `ready` rows carried the label: a direction with a countable end state ran
// unexecuted because nothing counted it. THE DECISION IS A FIELD, NOT A SENTENCE, so this reads two fields:
//   - the `tier:haiku` label (`HAIKU_TIER_LABEL`, the one the claim path reads), or
//   - a line opening `Tier: sonnet -- <reason>` in the row's body or in any of its comments, outside a code fence, with a NON-EMPTY reason. `Tier: sonnet --` and nothing
//     after it is a decision nobody made, and is counted.
//
// A ROW THE HAIKU RULE ALREADY EXCLUDES IS LISTED APART AND NOT COUNTED: `lane:ceo`, `lane:orchestrator`, `needs:chairman` and `hold:*`. Only such a row with no decision is listed
// apart (one that carries a decision is not a row anybody needs to look at), so the list answers "what would this count be if the rule excluded nothing".
//
// EVERY DECLARED TRACKER IS READ, because a row filed in a second tracker has a number the first one also has, and a count of the first alone is a count of half the stock.
// A tracker is named `#7` when its key is empty (the project's own) and `agent-org#7` otherwise, so two rows 7 are never one.
//
// A READ THE TOOL COULD NOT MAKE IS `unknown`, NEVER 0 (`org-retro.ts`'s header, #1286): a tracker that cannot be listed, a list that reached its limit (so it may be cut
// short), a row that came back with no labels or no comments field, or NO declared tracker at all makes the whole reading `unknown` and NAMES the read. Absence is not proof.
//
// THE OFFER (a11ign/agent-org#636): the number is a reading, and nothing yet acted on it. `untieredOffer` answers, per gate tick, whether `product-manager` is owed the sweep: the count is
// `read` and above zero on this tick AND on the one before (`UntieredMemory`, kept in the state dir), so a stock that exists for one tick is a row being filed and not a backlog. `unknown`
// never offers and is remembered as no count, so an unread tick between two above zero breaks the run: absence is not proof either way. The rows are KEYED SORTED (`untieredSweepKey`), so
// the same stock is one question however the tracker lists it.
//
// A LEAF: relative imports of leaves only, like `org-retro.ts`, which imports it and runs before any install.
import { execFileSync } from "node:child_process";
import { READY_LABEL } from "./claim-labels.ts";
import { HOLD_LABEL_PREFIX } from "./idle-claimant.ts";
import { LANE_PREFIX, NEEDS_CHAIRMAN_LABEL } from "./project-vocabulary.ts";
import { HAIKU_TIER_LABEL } from "./worker-profile.ts";

/** The `lane:` labels whose rows the Haiku rule excludes (`engineer-route.ts` refuses `lane:ceo` and `needs:chairman`; the orchestrator's rows reach the fleet). */
const EXCLUDED_LABELS = [`${LANE_PREFIX}ceo`, `${LANE_PREFIX}orchestrator`, NEEDS_CHAIRMAN_LABEL];

/** How many row names the printed line gives before it says how many more there are. */
export const LISTED_ROWS = 10;

/** More open `ready` rows than this in one tracker and the list may be cut short, which is a read the tool could not complete. */
export const ROW_LIST_LIMIT = 500;
const READ_TIMEOUT_MS = 90 * 1000;
const MAX_BUFFER = 64 * 1024 * 1024;

/** an open `ready` issue as `gh issue list --json number,title,body,labels,comments` returns it */
export type ReadyRow = { number: number, title?: string, body?: string | null, labels?: ({ name?: string } | string)[], comments?: ({ body?: string | null } | string)[] };
/** THE SEAM: one declared tracker. `key` is `""` for the project's own; `listRows` THROWS for a refused read. */
export type TrackerReader = { key: string, repo: string, listRows: () => ReadyRow[] };
/** `name` is how the row is written where two trackers meet: `#7` or `agent-org#7` */
export type UntieredRow = { number: number, name: string, title: string };
export type UntieredReady =
  | { status: "read", count: number, rows: UntieredRow[], apart: UntieredRow[] }
  | { status: "unknown", reads: string[] };

const FENCE = /^[ \t]*(```|~~~)/;
/** A line OPENING `Tier: sonnet -- ` and then at least one non-blank character: the reason the chairman's direction asks for. */
const TIER_LINE = /^[ \t]*Tier:[ \t]+sonnet[ \t]+--[ \t]+\S/i;

const labelNames = (row: ReadyRow): string[] => (row.labels ?? []).map((l) => (typeof l === "string" ? l : String(l?.name)));
const textOf = (entry: { body?: string | null } | string): string => (typeof entry === "string" ? entry : String(entry?.body ?? ""));

/** @param {string} text @returns {boolean} some line outside every fenced code block opens `Tier: sonnet -- <reason>` */
function hasTierLine(text: string): boolean {
  let fenced = false;
  for (const line of text.split(/\r?\n/)) {
    if (FENCE.test(line)) fenced = !fenced;
    else if (!fenced && TIER_LINE.test(line)) return true;
  }
  return false;
}

/** @param {ReadyRow} row @returns {boolean} the row has made a tier decision: the label, or the line in its body or a comment */
export function hasTierDecision(row: ReadyRow): boolean {
  return labelNames(row).includes(HAIKU_TIER_LABEL)
    || hasTierLine(String(row.body ?? ""))
    || (row.comments ?? []).some((comment) => hasTierLine(textOf(comment)));
}

/** @param {ReadyRow} row @returns {boolean} a label the Haiku rule already excludes the row by */
const isExcluded = (row: ReadyRow): boolean => labelNames(row).some((l) => EXCLUDED_LABELS.includes(l) || l.startsWith(HOLD_LABEL_PREFIX));

/** @param {unknown} err @returns {string} the first line, so a refusal is named and a stack is not printed */
const firstLine = (err: unknown): string => String((err as any)?.message ?? err).split("\n")[0];

const nameOf = (tracker: TrackerReader, number: number): string => `${tracker.key}#${number}`;

/**
 * Every untiered `ready` row of every tracker, or `unknown` naming each read that was refused. All trackers are read before the verdict, so the unknown names every
 * unreadable one and not the first.
 * @param {{ trackers: TrackerReader[] }} input
 * @returns {UntieredReady}
 */
export function untieredReadyRows({ trackers }: { trackers: TrackerReader[]; }): UntieredReady {
  if (trackers.length === 0) return { status: "unknown", reads: ["the declared trackers (none is declared)"] };
  const rows: UntieredRow[] = [];
  const apart: UntieredRow[] = [];
  const refused: string[] = [];
  for (const tracker of trackers) {
    const where = tracker.repo;
    let listed: ReadyRow[];
    try {
      listed = tracker.listRows();
    } catch (err) {
      refused.push(`the ready rows of ${where} (${firstLine(err)})`);
      continue;
    }
    if (listed.length >= ROW_LIST_LIMIT) {
      refused.push(`the ready rows of ${where} (${listed.length} rows reached the ${ROW_LIST_LIMIT} limit, so the list may be cut short)`);
      continue;
    }
    for (const row of listed) {
      if (!Array.isArray(row.labels) || !Array.isArray(row.comments)) {
        refused.push(`the ${!Array.isArray(row.labels) ? "labels" : "comments"} of ${nameOf(tracker, row.number)} in ${where}`);
        continue;
      }
      if (!labelNames(row).includes(READY_LABEL) || hasTierDecision(row)) continue;
      const listedRow = { number: row.number, name: nameOf(tracker, row.number), title: String(row.title ?? "") };
      (isExcluded(row) ? apart : rows).push(listedRow);
    }
  }
  if (refused.length > 0) return { status: "unknown", reads: refused };
  return { status: "read", count: rows.length, rows, apart };
}

/** The previous gate tick's reading: its count, or `null` when that tick's read was `unknown` (or this is the first tick). */
export type UntieredMemory = { count: number | null };
/** Kept in the state dir (`stateEntryPath("")`), beside `dora-reading.json`. */
export const UNTIERED_MEMORY_FILE = "untiered-ready-reading.json";

/** @param {unknown} kept the parsed file @returns {UntieredMemory} anything that is not `{ count: <non-negative integer> }` is no count */
export function parseUntieredMemory(kept: unknown): UntieredMemory {
  const count = (kept as { count?: unknown } | null)?.count;
  return { count: typeof count === "number" && Number.isInteger(count) && count >= 0 ? count : null };
}

/** @param {UntieredRow} a @param {UntieredRow} b @returns {number} by tracker (the project's own first), then row number */
const byTrackerThenNumber = (a: UntieredRow, b: UntieredRow): number => {
  const trackerOf = (row: UntieredRow) => row.name.slice(0, row.name.lastIndexOf("#"));
  const [x, y] = [trackerOf(a), trackerOf(b)];
  return x === y ? a.number - b.number : x < y ? -1 : 1;
};

/** @param {UntieredRow[]} rows @returns {string} the rows' names, sorted, so the same stock is the same key in any order */
export const untieredSweepKey = (rows: UntieredRow[]): string => [...rows].sort(byTrackerThenNumber).map((r) => r.name).join(",");

/**
 * Is the sweep owed this tick, and what is the memory to keep? Pure. `rows` is the stock to name, sorted, or `null` when nothing is offered.
 * @param {UntieredReady | null | undefined} ready this tick's reading @param {UntieredMemory | null} previous the last tick's, `null` when there is none
 * @returns {{ rows: UntieredRow[] | null, memory: UntieredMemory }}
 */
export function untieredOffer(ready: UntieredReady | null | undefined, previous: UntieredMemory | null): { rows: UntieredRow[] | null; memory: UntieredMemory; } {
  if (ready === null || ready === undefined || ready.status !== "read") return { rows: null, memory: { count: null } };
  const owed = ready.count > 0 && (previous?.count ?? 0) > 0;
  return { rows: owed ? [...ready.rows].sort(byTrackerThenNumber) : null, memory: { count: ready.count } };
}

const names = (rows: UntieredRow[]): string => rows.slice(0, LISTED_ROWS).map((r) => r.name).join(", ") + (rows.length > LISTED_ROWS ? `, and ${rows.length - LISTED_ROWS} more` : "");

/**
 * The printed lines: the number and the first ten rows, or the reads that made it unknown.
 * @param {UntieredReady | null | undefined} ready `null`/`undefined` is a read nobody made, which is `unknown` too
 * @returns {string[]}
 */
export function untieredLines(ready: UntieredReady | null | undefined): string[] {
  const label = `Ready rows with no tier decision (no \`${HAIKU_TIER_LABEL}\` label, no \`Tier: sonnet -- <reason>\` line)`;
  if (ready === null || ready === undefined) return [`- ${label}: unknown (the trackers were not read)`];
  if (ready.status === "unknown") return [`- ${label}: unknown (could not read ${ready.reads.join("; ")})`];
  const apart = ready.apart.length === 0 ? "" : `; listed apart, not counted (lane:ceo, lane:orchestrator, needs:chairman or hold:*): ${names(ready.apart)}`;
  if (ready.count === 0) return [`- ${label}: 0${apart}`];
  return [`- ${label}: ${ready.count}: first ${Math.min(ready.count, LISTED_ROWS)}: ${names(ready.rows)}${apart}`];
}

/** @param {string[]} args @returns {string} */
function gh(args: string[]): string {
  return execFileSync("gh", args, { encoding: "utf8", maxBuffer: MAX_BUFFER, stdio: ["ignore", "pipe", "pipe"], timeout: READ_TIMEOUT_MS });
}

/**
 * THE REAL READER of one declared tracker: one issue list of its open `ready` rows, carrying the fields read. A failure throws; `untieredReadyRows` names it.
 * @param {{ key: string, repo: string }} tracker `repo` is `owner/name` @param {(args: string[]) => string} [run] @returns {TrackerReader}
 */
export function ghReadyReader({ key, repo }: { key: string; repo: string; }, run: (args: string[]) => string = gh): TrackerReader {
  return {
    key,
    repo,
    listRows: () => JSON.parse(run(["issue", "list", "--repo", repo, "--state", "open", "--label", READY_LABEL, "--limit", String(ROW_LIST_LIMIT), "--json", "number,title,body,labels,comments"])),
  };
}
