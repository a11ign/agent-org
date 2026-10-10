// @ts-check
// no-token: gh
// A BUILD ROW CLOSES ON MERGE, AND THE LIVE READING IT NAMED BECOMES ITS OWN VERIFY ROW (a11ign/a11ign#4641, class `row-not-finishable`; the chairman, 2026-10-09:
// READY MEANS FINISHABLE). A row whose Done-when needs a live reading can neither close on merge (the reading is lost: #4524 closed on its PR with half the change
// unshipped) nor stay open (an engineer sits holding the claim: worker-3870 on #3870; #4438 and #4441 for 10.5 h). So the build closes, and in the same turn this
// files `Verify <build title>` carrying ONLY the live Done-when item, behind a `Not-before:` and a blocked-by edge on the build, as a sub-issue of the build's epic,
// so the epic's `subIssuesSummary` counts the build done when the verify row closes and not before.
//
// WHAT COUNTS AS A LIVE READING: a `future-time` item (the classifier #4640 wrote, `unfinishableItems`) and a `live-check` item (a quoted record on a row, a switch read
// on, a log line after the merge, a published version: `liveCheckItems`, a11ign/agent-org#719). A `seat-act` or `row-outcome` item is not a reading, `row-file`
// already refuses a body carrying one, and a verify row filed for it would be unfinishable by an engineer all over again; the outcome NAMES such an item as declined.
//
// IDEMPOTENT: the body carries `<!-- verify-row: build #N -->`, and a build that already has a row with that marker files nothing. A search that CANNOT be read
// files nothing either and says so, because "could not look" is not "there is none" and a duplicate is harder to undo than a retry (the job exits 1 and the next
// run files it).
//
// NOT HERE: the fixed-measurement script lines are #4639's grammar and are not invented before it lands; the `Roadmap` Project field has no reader in this
// repository, so only the sub-issue link (what the epic counts) is copied; and Project boarding is `row-file --board=`'s, which refuses a row with no Region, so
// a verify row is filed `backlog` and a refusal is reported beside it rather than hidden.
//
// A LEAF over its effects: every read and write arrives as an argument, so the tests reach no network.
import { BACKLOG_LABEL, LANE_PREFIX, OUT_OF_RELEASE_LABEL } from "./project-vocabulary.ts";
import { doneWhenItems, liveCheckItems, unfinishableItems, type LiveCheckItem, type UnfinishableItem } from "./unsplit-done-when.ts";

/** An item a verify row takes: a `future-time` item or a `live-check` one. */
export type ReadingItem = LiveCheckItem | (UnfinishableItem & { kind: "future-time"; });
/** An item that reads like a reading but is not one a verify row can take: a seat's act or another row's outcome. */
export type DeclinedItem = { text: string; kind: "seat-act" | "row-outcome"; evidence: string; };

export type BuildRow = { number: number; title: string; body: string; labels: string[]; milestone: string | null; parent: number | null; };
export type VerifyPlan = {
  title: string; body: string; labels: string[]; milestone: string | null; blockedBy: number; parent: number | null; notBefore: string;
  /** The first reading; `items` is every one the row carries. */
  item: ReadingItem; items: ReadingItem[];
};
export type VerifyEffects = {
  /** The verify row already filed for this build, `null` when the search ANSWERED none; throws when it could not be read. */
  findExisting: (build: BuildRow) => number | null;
  create: (plan: VerifyPlan) => number;
  blockBy: (child: number, build: number) => void;
  addSubIssue: (child: number, parent: number) => void;
  /** `null` when boarded, else why not. */
  board: (child: number) => string | null;
};
export type VerifyOutcome =
  | { kind: "none"; declined?: DeclinedItem[] }
  | { kind: "already"; number: number }
  | { kind: "filed"; number: number; plan: VerifyPlan; problems: string[]; declined?: DeclinedItem[] }
  | { kind: "failed"; reason: string };

const MS = { minute: 60_000, hour: 3_600_000, day: 86_400_000, week: 604_800_000, month: 30 * 86_400_000 } as const;
const WORD_COUNT: Record<string, number> = { a: 1, an: 1, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7 };
const WEEKDAYS = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];
const STAMP = (at: number) => new Date(at).toISOString().replace(/\.\d{3}Z$/, "Z");
const DAYS_IN_WEEK = 7;
const FALLBACK_WAIT_MS = MS.day;

/** The marker that makes a second merge of the same build find the first one's verify row. */
export const verifyMarker = (build: number) => `<!-- verify-row: build #${build} -->`;
export const verifyTitle = (build: BuildRow) => `Verify ${build.title}`;

/** A build's Done-when alone: the items are read as if no wait were already data, because on a build row a `Not-before:` gates its START, not this reading. */
const doneWhenAlone = (body: string) => `## Done-when\n\n${doneWhenItems(body).map((item) => `- ${item}`).join("\n")}\n`;

/** The Done-when items of a build row a verify row takes (`future-time` and `live-check`), in the order the row wrote them. `self` is the build's own number. */
export function liveReadingItems(body: string, now: Date, self?: number): ReadingItem[] {
  const alone = doneWhenAlone(body);
  const future = unfinishableItems(alone, { now }).flatMap((item): ReadingItem[] => (item.kind === "future-time" ? [{ ...item, kind: "future-time" }] : []));
  const live = liveCheckItems(alone, { now, self });
  const order = doneWhenItems(alone);
  return [...future, ...live].sort((a, b) => order.indexOf(a.text) - order.indexOf(b.text));
}

/** The items that read like a reading and are not one a verify row can take, so the close can say why it filed none for them. */
export function declinedItems(body: string, now: Date): DeclinedItem[] {
  return unfinishableItems(doneWhenAlone(body), { now }).flatMap((item) => (item.kind === "seat-act" || item.kind === "row-outcome"
    ? [{ text: item.text, kind: item.kind, evidence: item.evidence }] : []));
}

function unitMs(unit: string): number | undefined { return MS[unit.replace(/s$/, "").toLowerCase() as keyof typeof MS]; }
function countOf(word: string): number { return WORD_COUNT[word.toLowerCase()] ?? Number(word); }

function nextWeekday(from: number, name: string): number {
  const date = new Date(from);
  const ahead = ((WEEKDAYS.indexOf(name.toLowerCase()) - date.getUTCDay() + DAYS_IN_WEEK) % DAYS_IN_WEEK) || DAYS_IN_WEEK; // "next monday" on a Monday is a week on
  return Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()) + ahead * MS.day;
}

/** The instant a classified `future-time` phrase ends, from the merge: `null` when the phrase is one this cannot place. */
function placed(evidence: string, mergedAt: number): number | null {
  const iso = /^(\d{4}-\d{2}-\d{2})(?:T(\d{2}:\d{2})(?::(\d{2}))?)?Z?$/.exec(evidence);
  if (iso) return Date.parse(`${iso[1]}T${iso[2] ?? "00:00"}:${iso[3] ?? "00"}Z`);
  const day = /^on day (\d+)$/i.exec(evidence);
  if (day) return mergedAt + Number(day[1]) * MS.day;
  if (/^(?:tomorrow|overnight)$/i.test(evidence)) return mergedAt + MS.day;
  const next = /^next (week|month|\w+day)$/i.exec(evidence);
  if (next) return /^(week|month)$/i.test(next[1]) ? mergedAt + (unitMs(next[1]) as number) : nextWeekday(mergedAt, next[1]);
  const span = /^(?:(?:in|after|within)\s+(\w+)\s+(\w+)|(\w+)\s+(\w+)\s+(?:later|after|from now))$/i.exec(evidence);
  if (!span) return null;
  const [count, unit] = span[1] ? [span[1], span[2]] : [span[3], span[4]];
  const wait = countOf(count) * (unitMs(unit) ?? Number.NaN);
  return Number.isFinite(wait) && wait > 0 ? mergedAt + wait : null;
}

/** The `Not-before:` stamp for a reading, and whether it was PLACED from the item's own words or fell back to a day after the merge. */
export function notBeforeFor(item: ReadingItem | UnfinishableItem, mergedAt: string): { stamp: string; placed: boolean; } {
  const at = Date.parse(mergedAt);
  const found = placed(item.evidence, at);
  return found === null ? { stamp: STAMP(at + FALLBACK_WAIT_MS), placed: false } : { stamp: STAMP(found), placed: true };
}

function verifyBody(build: BuildRow, { items, notBefore, unplaced, pr }: { items: ReadingItem[]; notBefore: string; unplaced: ReadingItem | null; pr: string; }): string {
  const fallback = unplaced === null ? "" : `\nThe item names no time this could place (\`${unplaced.evidence}\`), so \`Not-before:\` is a day after the merge: \`product-manager\` adjusts it.\n`;
  return `## What it is\n\nThe live reading of #${build.number} (\`${build.title}\`), taken separately because the build closed on its merge (${pr}). `
    + `Filed by the pipeline the moment it closed (#4641): the build is done for the epic only when this row passes.\n${fallback}\n`
    + `## Done-when\n\n${items.map((item, i) => `${i + 1}. ${item.text}`).join("\n")}\n\nNot-before: ${notBefore}\nVerifies: #${build.number}\n\n${verifyMarker(build.number)}\n`;
}

/** The verify row a build would file, `null` when its Done-when names no live reading. PURE: the control for "a row with no live reading files nothing". */
export function planVerifyRow(build: BuildRow, { pr, mergedAt, now = new Date(mergedAt) }: { pr: string; mergedAt: string; now?: Date; }): VerifyPlan | null {
  const items = liveReadingItems(build.body, now, build.number);
  const [item] = items;
  if (!item) return null;
  // One row carries every reading, so it is not readable before the LATEST of their waits.
  const waits = items.map((reading) => ({ reading, ...notBeforeFor(reading, mergedAt) }));
  const latest = waits.reduce((last, wait) => (Date.parse(wait.stamp) > Date.parse(last.stamp) ? wait : last));
  const stamp = latest.stamp;
  const carried = build.labels.filter((label) => label.startsWith(LANE_PREFIX) || label === OUT_OF_RELEASE_LABEL);
  return { title: verifyTitle(build), body: verifyBody(build, { items, notBefore: stamp, unplaced: latest.placed ? null : latest.reading, pr }), labels: [BACKLOG_LABEL, ...carried],
    milestone: build.milestone, blockedBy: build.number, parent: build.parent, notBefore: stamp, item, items };
}

function attempt(problems: string[], what: string, step: () => string | null | void): void {
  try {
    const refused = step();
    if (typeof refused === "string") problems.push(`${what}: ${refused}`);
  } catch (cause) {
    problems.push(`${what}: ${cause instanceof Error ? cause.message : cause}`);
  }
}

/** THE WHOLE ACT for one closed build row: plan, look for the first filing, file, then link. A link that fails is REPORTED beside the row (it exists and is findable). */
export function fileVerifyRow(build: BuildRow, ctx: { pr: string; mergedAt: string; }, effects: VerifyEffects): VerifyOutcome {
  const plan = planVerifyRow(build, ctx);
  const declined = declinedItems(build.body, new Date(ctx.mergedAt));
  const said = declined.length ? { declined } : {};
  if (!plan) return { kind: "none", ...said };
  let existing: number | null;
  try {
    existing = effects.findExisting(build);
  } catch (cause) {
    return { kind: "failed", reason: `could not check whether #${build.number} already has a verify row, so none was filed (${cause instanceof Error ? cause.message : cause})` };
  }
  if (existing !== null) return { kind: "already", number: existing };
  let child: number;
  try {
    child = effects.create(plan);
  } catch (cause) {
    return { kind: "failed", reason: `creating the verify row failed (${cause instanceof Error ? cause.message : cause})` };
  }
  const problems: string[] = [];
  attempt(problems, "blocked-by edge", () => effects.blockBy(child, plan.blockedBy));
  if (plan.parent !== null) attempt(problems, `sub-issue of #${plan.parent}`, () => effects.addSubIssue(child, plan.parent as number));
  attempt(problems, "board", () => effects.board(child));
  return { kind: "filed", number: child, plan, problems, ...said };
}
