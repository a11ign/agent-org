// @ts-check
// UNSPLIT DONE-WHEN (a11ign/a11ign#4640, class `row-not-finishable`; the chairman, 2026-10-09: READY MEANS FINISHABLE): a Done-when item that no engineer
// can finish from claim to merge is a different row. `row-file` refuses a body carrying one unless that part is its own row, and offers the split.
//
// THREE CLASSES OF ITEM THE ROW CANNOT FINISH THROUGH, each a fact a worker would sit holding the claim for (worker-3870 held #3870 idle while the gate
// deferred other ready rows for lack of an engineer; #4438 and #4441 were held claimed 10.5 h by a read-back an engineer could not make):
//   future-time   the item is true only LATER: `on day 3`, `after 2026-10-12`, `in three days`, a timestamp after the filing clock.
//   seat-act      a seat or the chairman is the actor of the verb: `ceo approves`, `confirmed by the chairman`, `product-manager's ruling`.
//   row-outcome   another row's outcome: `once #4438 merges`, `after #4441 closes`, `waits on #12`.
//
// NOT REFUSED, and each has a pinned control: a wait that is ALREADY DATA on the row (a `Not-before:` line, a `Waiting-for:` line, a `Waits-on-done-when:` line,
// a `--blocked-by` edge, an `answer:<session>` or `needs:chairman` label), because the gate, not the engineer, holds that wait; and a row, a seat or a date that
// is only CITED (`see #4437`, `routing: ceo's comments`, `before 2026-10-20`, a deadline being a bound on the work and no wait for it).
//
// A LEAF: pure, no network and no `gh`. `row-file.ts` owns the call and the exit code; the clock and the label list arrive as arguments.
import { parseWaits, namedDoneWhens } from "./wait-condition.ts";
import { notBeforeDate } from "./waiting-condition.ts";
import { ANSWER_PREFIX, NEEDS_CHAIRMAN_LABEL } from "./project-vocabulary.ts";

export type UnfinishableClass = "future-time" | "seat-act" | "row-outcome";
export type UnfinishableItem = { text: string; kind: UnfinishableClass; evidence: string; rows: number[]; };
/** What the row already carries as data. `blockedBy` and `labels` are the filing's own arguments, which the body cannot hold. */
export type RowDeclarations = { blockedBy?: readonly number[]; labels?: readonly string[]; };

const DONE_WHEN_HEADING = /^[ \t]*#{1,6}[ \t]*done[- ]when\b/i;
const ANY_HEADING = /^[ \t]*#{1,6}[ \t]/;
const ITEM_START = /^ {0,3}(?:\d+[.)]|[-*+])[ \t]+/;
const FENCE = /^[ \t]*(```|~~~)/;
const ISO_INSTANT = /(?<!\w)(\d{4}-\d{2}-\d{2})(T\d{2}:\d{2}(?::\d{2})?Z?)?(?!\w)/g;
const DEADLINE_BEFORE_DATE = /\b(?:before|by|within|no later than)\s+$/i;
const ROW_REFERENCE = "(?:(?:the\\s+)?(?:row|pr|pull request|issue)\\s+)?(?:[\\w.-]+/[\\w.-]+)?#(\\d+)";
const COUNT = "(?:a|an|one|two|three|four|five|six|seven|\\d+)";
const UNIT = "(?:minute|hour|day|week|month)s?";

const RELATIVE_TIME: readonly RegExp[] = [
  /\bon day \d+\b/i,
  /\b(?:tomorrow|overnight)\b/i,
  /\bnext (?:week|month|monday|tuesday|wednesday|thursday|friday|saturday|sunday)\b/i,
  new RegExp(`\\b(?:in|after|within)\\s+${COUNT}\\s+${UNIT}\\b`, "i"),
  new RegExp(`\\b${COUNT}\\s+${UNIT}\\s+(?:later|after|from now)\\b`, "i"),
];

const SEAT = "(?:the\\s+)?(?:product-manager|ceo|orchestrator|chairman)";
const MODAL = "(?:(?:also|then|must|will|has|have|can|may|should|first|explicitly)\\s+)*";
const ACT = "(?:approves?|approved|signs? off|signed off|rules?|ruled|confirms?|confirmed|accepts?|accepted|replies|replied|answers?|answered|posts?|posted|reads?|read|"
  + "reviews?|reviewed|decides?|decided|lifts?|lifted|releases?|released|reports?|reported|declares?|declared|greenlights?|says?|said|agrees?|agreed|verif(?:y|ies|ied)|"
  + "checks?|checked|disposes?|disposed|runs?|ran|merges?|merged|publishes?|published)";
const SEAT_NOUN = "(?:approval|ruling|sign-off|confirmation|answer|reply|verdict|decision|reading|go-ahead)";

const SEAT_ACT: readonly RegExp[] = [
  new RegExp(`\\b${SEAT}\\s+${MODAL}${ACT}\\b`, "i"),
  new RegExp(`\\b${ACT}\\s+by\\s+${SEAT}\\b`, "i"),
  new RegExp(`\\b${SEAT}(?:'s|\\u2019s)\\s+${SEAT_NOUN}\\b`, "i"),
  new RegExp(`\\b${SEAT_NOUN}\\s+(?:from|of|by)\\s+${SEAT}\\b`, "i"),
];

const ROW_OUTCOME_VERB = "(?:merges|merged|closes|closed|lands|landed|ships|shipped|finishes|finished|completes|completed|publishes|published|is done|is merged|is closed|is published|"
  + "has merged|has closed|has landed|is finished|is complete)";
const ROW_OUTCOME: readonly RegExp[] = [
  new RegExp(`\\b(?:once|after|when|until|following)\\s+${ROW_REFERENCE}\\s+${ROW_OUTCOME_VERB}\\b`, "i"),
  new RegExp(`\\b(?:waits?|waiting|blocked|depends?|dependent)\\s+(?:for|on|by|upon)\\s+${ROW_REFERENCE}\\b`, "i"),
  new RegExp(`(?<![\\w/])${ROW_REFERENCE}(?:'s|\\u2019s)\\s+(?:merge|close|landing|outcome|reading|verdict|completion)\\b`, "i"),
];

/** The Done-when ITEMS of a body: a numbered or bulleted line with its wrapped continuations, else one item per paragraph. Fenced blocks are not items. */
export function doneWhenItems(body: string | null | undefined): string[] {
  const items: string[] = [];
  let inSection = false;
  let fenced = false;
  let wrapping = false;
  for (const line of String(body ?? "").split(/\r\n|\r|\n/)) {
    if (FENCE.test(line)) { fenced = !fenced; continue; }
    if (fenced) continue;
    if (DONE_WHEN_HEADING.test(line)) { inSection = true; continue; }
    if (ANY_HEADING.test(line)) { inSection = false; continue; }
    if (!inSection) continue;
    if (line.trim() === "") { wrapping = false; continue; } // a blank line ends the item: a following paragraph is its own
    if (ITEM_START.test(line) || !wrapping) items.push(line.replace(ITEM_START, "").trim());
    else items[items.length - 1] += ` ${line.trim()}`;
    wrapping = true;
  }
  return items;
}

/** The first instant in an item that is LATER than `now` and is not a deadline (`before`, `by`), as written; `null` when none. A date-only value is midnight UTC. */
function laterInstant(item: string, now: Date): string | null {
  for (const m of item.matchAll(ISO_INSTANT)) {
    if (DEADLINE_BEFORE_DATE.test(item.slice(0, m.index))) continue;
    const written = m[0];
    const time = (m[2] ?? "T00:00").replace(/Z$/, "");
    const at = Date.parse(`${m[1]}${time.length === "THH:MM".length ? `${time}:00` : time}Z`);
    if (Number.isFinite(at) && at > now.getTime()) return written;
  }
  return null;
}

function firstMatch(patterns: readonly RegExp[], item: string): RegExpExecArray | null {
  for (const pattern of patterns) {
    const found = pattern.exec(item);
    if (found) return found;
  }
  return null;
}

function classify(item: string, now: Date): Omit<UnfinishableItem, "text"> | null {
  const instant = laterInstant(item, now);
  if (instant) return { kind: "future-time", evidence: instant, rows: [] };
  const relative = firstMatch(RELATIVE_TIME, item);
  if (relative) return { kind: "future-time", evidence: relative[0], rows: [] };
  const seat = firstMatch(SEAT_ACT, item);
  if (seat) return { kind: "seat-act", evidence: seat[0], rows: [] };
  const row = firstMatch(ROW_OUTCOME, item);
  if (row) return { kind: "row-outcome", evidence: row[0], rows: [Number(row[1])] };
  return null;
}

/** Is the wait this item names ALREADY DATA on the row, so the gate holds it and the engineer never does? */
function alreadyData(found: Omit<UnfinishableItem, "text">, { body, declared }: { body: string; declared: RowDeclarations; }): boolean {
  const readable = parseWaits(body).filter((wait) => wait.state !== "unreadable");
  if (found.kind === "future-time") return notBeforeDate(body) !== null || readable.length > 0;
  if (found.kind === "seat-act") {
    const labels = (declared.labels ?? []).map((label) => label.toLowerCase());
    return readable.length > 0 || labels.some((label) => label.startsWith(ANSWER_PREFIX) || label === NEEDS_CHAIRMAN_LABEL);
  }
  const edges = new Set([...(declared.blockedBy ?? []), ...namedDoneWhens(body).map((named) => named.row)]);
  const waited = readable.flatMap((wait) => [...wait.text.matchAll(/#(\d+)/g)].map((m) => Number(m[1])));
  return found.rows.every((row) => edges.has(row) || waited.includes(row));
}

/** Every Done-when item the row cannot finish through and does not already carry as data. `[]` is a row that is finishable as written. */
export function unfinishableItems(body: string, { now = new Date(), declared = {} }: { now?: Date; declared?: RowDeclarations; } = {}): UnfinishableItem[] {
  return doneWhenItems(body).flatMap((text) => {
    const found = classify(text, now);
    return found && !alreadyData(found, { body, declared }) ? [{ text, ...found }] : [];
  });
}

/** What the SECOND row would carry for this item: the data that makes the wait the gate's. */
function carriedData(item: UnfinishableItem): string {
  if (item.kind === "future-time") {
    const absolute = /^\d{4}-\d{2}-\d{2}/.test(item.evidence) ? item.evidence : "<YYYY-MM-DDTHH:MM:SSZ the wait ends>";
    const stamp = absolute.includes("T") || absolute.startsWith("<") ? absolute : `${absolute}T00:00:00Z`;
    return `a \`Not-before: ${stamp}\` line (seconds and the \`Z\` are required)`;
  }
  if (item.kind === "seat-act") {
    return `the owner label: \`${ANSWER_PREFIX}<session>\` for a seat's act (removing it IS the answer), or \`${NEEDS_CHAIRMAN_LABEL}\` with a \`BRIEF for the chairman\` for the chairman's`;
  }
  const [row] = item.rows;
  return `\`--blocked-by ${row}\` (and \`Waits-on-done-when: ${row}.<k>\` when #${row} has several done-whens), or a \`Waiting-for: closed|merged #${row}\` line`;
}

/**
 * THE REFUSAL, with the split offered: for each item, the exact second row's Done-when and the data it carries. `null` means proceed.
 * @returns {string | null}
 */
export function unsplitDoneWhenRefusal(body: string, options: { now?: Date; declared?: RowDeclarations; } = {}): string | null {
  const items = unfinishableItems(body, options);
  if (items.length === 0) return null;
  const lines = items.map((item, i) => `  ${i + 1}. [${item.kind}: \`${item.evidence}\`] "${item.text}"\n`
    + `     SECOND ROW's Done-when: "${item.text}"\n     it carries: ${carriedData(item)}.`);
  return `row-file: REFUSING to file -- ${items.length} Done-when item(s) name something no engineer can finish from claim to merge (a future time, a seat's or the chairman's act, `
    + "or another row's outcome), so the row would be claimed and then held idle on it (READY MEANS FINISHABLE; worker-3870 sat on #3870, #4438 and #4441 were held 10.5 h):\n"
    + `${lines.join("\n")}\n`
    + "File each as its OWN row with that Done-when and the data above, and take the item out of THIS row's Done-when (or put the wait on THIS row as data: a `Not-before:`, a "
    + "`Waiting-for:`, a `Waits-on-done-when:`, a `--blocked-by` edge, an `answer:<session>` label). A row that only CITES a row, a seat or a date is not refused. Nothing was filed.";
}
