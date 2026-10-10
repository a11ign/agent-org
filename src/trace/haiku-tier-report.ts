// a11ign/a11ign#4382: THE HAIKU TIER'S REPORT -- the four measures the chairman named, per tier, and the stop rule written on that row BEFORE the first Haiku worker started.
//
// `node src/trace/haiku-tier-report.ts [--store <events.ndjson>]` reads the rows closed since the first Haiku turn and their pull requests from `gh` (`issue list --search "closed:<from>..<to>"`) and the turns, compactions and
// reviews from the trace store, and prints for `tier:haiku` rows and for the other rows closed in the same window: first-pass merge, review rejections per pull request,
// compactions, and cost per closed row (turns per row beside them, which is NOT a stop condition), and each row's effort with the arm split by it (agent-org#469). `ceo` reads it once, at 8 closed Haiku rows or 72 hours after the first
// Haiku worker starts, and applies (a)-(e) below.
//
// WHAT IS MEASURED AND WHAT IS DEFINED, because the two wear the same clothes in a report:
//   first-pass merge   DEFINED: a pull request merged with no `CHANGES_REQUESTED` review on any earlier head. Reviews are the store's `reviewed` events; a comment is not a verdict.
//   rejections         MEASURED: `CHANGES_REQUESTED` reviews of the row's pull request, per pull request that merged.
//   compactions        MEASURED: the store's `compaction` events, counted per SESSION (a row may take more than one instance); the largest is the figure.
//   refused for length INFERRED: a Haiku turn whose prompt is over the ceiling is priced `null` (`costOf`, `maxPrompt`), and a refused request leaves no turn at all, so this counts
//                      the turns the store DID record above the ceiling and is a floor on the refusals.
//   cost per row       MEASURED turns, PRICED from `PRICES` now (`repriceEvents`); a row with an unpriced turn is a FLOOR and says so.
//   effort             MEASURED: the `effort` the transcript names on each turn (`store.ts` `effortOf`), per row: the one value its turns ran at, `mixed` where they differ, `unknown`
//                      where none names one. A turn that names none is left out of the comparison and an unknown row is NEVER counted as `low`. It splits an arm; it is no stop condition.
// A rate over fewer than MIN_RATE_ROWS rows is printed "n=<k>, not a rate" and decides nothing.
import { execFileSync } from "node:child_process";
import { realpathSync } from "node:fs";
import { pathToFileURL } from "node:url";
import type { TraceEvent } from "./store.ts";
import { eventsForRow, readStore, repriceEvents } from "./store.ts";
import { defaultStore } from "./otel-receiver.ts";
import { HAIKU_MODEL_ID, HAIKU_TIER_LABEL } from "../worker-profile.ts";
import { REPO } from "../project-identity.ts";

export const MIN_RATE_ROWS = 8;
export const WINDOW_HOURS = 72;
export const MIN_ROWS_IN_WINDOW = 4;
export const FIRST_PASS_GAP_POINTS = 20;
export const REJECTIONS_GAP_PER_PR = 0.5;
export const MAX_COMPACTIONS = 10;
export const MIN_SAVING_FRACTION = 0.4;
const MS_PER_HOUR = 3_600_000;
const PERCENT = 100;

/** `pr` is null both where the row has no closing pull request and where it has one whose repository cannot be read; `unresolved` tells the two apart (agent-org#689), and a row built without it is not. */
export type ClosedRow = { number: number; haiku: boolean; closedAt: number; pr: { repo: string; number: number } | null; unresolved?: boolean };
export type RowMeasures = { number: number; haiku: boolean; merged: boolean; rejections: number; compactions: number; oversize: number; turns: number; costUsd: number; unpriced: number; effort: string };

export const EFFORT_MIXED = "mixed";
export const EFFORT_UNKNOWN = "unknown";

export function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

/** The reviews and merge of one pull request, from the store's `github` events (their ids carry the repository, so another repository's pull request of the same number is not read). */
function pullEvents(events: TraceEvent[], pr: { repo: string; number: number }): TraceEvent[] {
  const prefix = `gh:${pr.repo}#${pr.number}:`;
  return events.filter((event) => event.source === "github" && event.id.startsWith(prefix));
}

/** The most compactions any ONE session of the row took. */
function mostCompactions(rowEvents: TraceEvent[]): number {
  const perSession = new Map<string, number>();
  for (const event of rowEvents.filter((e) => e.kind === "compaction")) perSession.set(event.session, (perSession.get(event.session) ?? 0) + 1);
  return Math.max(0, ...perSession.values());
}

function spend(turns: TraceEvent[]): { costUsd: number; unpriced: number } {
  const priced = turns.filter((turn) => typeof turn.costUsd === "number");
  return { costUsd: priced.reduce((sum, turn) => sum + (turn.costUsd as number), 0), unpriced: turns.length - priced.length };
}

/** The effort a row's turns ran at: their one value, `mixed` when they differ, `unknown` when none names one (a turn that names none is not a vote for any value). */
export function effortOfTurns(turns: TraceEvent[]): string {
  const named = new Set(turns.map((turn) => turn.effort).filter((effort): effort is string => typeof effort === "string" && effort !== ""));
  if (named.size === 0) return EFFORT_UNKNOWN;
  return named.size === 1 ? [...named][0] : EFFORT_MIXED;
}

/** One closed row's figures. `events` must already be repriced. */
export function measuresOf(row: ClosedRow, events: TraceEvent[]): RowMeasures {
  const about = eventsForRow(events, { rows: [row.number], prs: [] });
  const turns = about.filter((event) => event.kind === "turn");
  const pull = row.pr === null ? [] : pullEvents(events, row.pr);
  const oversize = turns.filter((turn) => turn.model?.startsWith(HAIKU_MODEL_ID) && turn.costUsd === null).length;
  return { number: row.number, haiku: row.haiku, merged: pull.some((event) => event.kind === "merged"),
    rejections: pull.filter((event) => event.kind === "reviewed" && event.state === "CHANGES_REQUESTED").length,
    compactions: mostCompactions(about), oversize, turns: turns.length, ...spend(turns), effort: effortOfTurns(turns) };
}

export function summarise(rows: RowMeasures[]) {
  const merged = rows.filter((row) => row.merged);
  const priced = rows.filter((row) => row.turns > 0);
  return { n: rows.length, nMerged: merged.length,
    firstPassRate: merged.length === 0 ? null : merged.filter((row) => row.rejections === 0).length / merged.length,
    meanRejections: merged.length === 0 ? null : merged.reduce((sum, row) => sum + row.rejections, 0) / merged.length,
    mostCompactions: Math.max(0, ...rows.map((row) => row.compactions)), oversize: rows.reduce((sum, row) => sum + row.oversize, 0),
    nCost: priced.length, floors: priced.filter((row) => row.unpriced > 0).length, medianCostUsd: median(priced.map((row) => row.costUsd)),
    medianTurns: median(rows.map((row) => row.turns)) };
}

type Summary = ReturnType<typeof summarise>;
export type Verdict = { id: string; tripped: boolean | null; line: string };

const rateText = (n: number, rate: number): string => (n < MIN_RATE_ROWS ? `n=${n}, not a rate` : `${(rate * PERCENT).toFixed(0)}% (n=${n})`);

/** (a): the Haiku rate more than FIRST_PASS_GAP_POINTS below the others'. Decides only when BOTH are rates. */
function firstPassVerdict(haiku: Summary, other: Summary): Verdict {
  const shown = `Haiku ${rateText(haiku.nMerged, haiku.firstPassRate ?? 0)}, others ${rateText(other.nMerged, other.firstPassRate ?? 0)}`;
  if (haiku.nMerged < MIN_RATE_ROWS || other.nMerged < MIN_RATE_ROWS) return { id: "a", tripped: null, line: `(a) first-pass merge: ${shown} -- not readable` };
  const gap = ((other.firstPassRate ?? 0) - (haiku.firstPassRate ?? 0)) * PERCENT;
  return { id: "a", tripped: gap > FIRST_PASS_GAP_POINTS, line: `(a) first-pass merge: ${shown}; gap ${gap.toFixed(0)} points (stop above ${FIRST_PASS_GAP_POINTS})` };
}

/** (b): rejections per pull request more than REJECTIONS_GAP_PER_PR above the others' mean. */
function rejectionsVerdict(haiku: Summary, other: Summary): Verdict {
  const shown = `Haiku ${haiku.meanRejections?.toFixed(2) ?? "none"} per PR (n=${haiku.nMerged}), others ${other.meanRejections?.toFixed(2) ?? "none"} (n=${other.nMerged})`;
  if (haiku.meanRejections === null || other.meanRejections === null) return { id: "b", tripped: null, line: `(b) review rejections: ${shown} -- not readable` };
  const gap = haiku.meanRejections - other.meanRejections;
  return { id: "b", tripped: gap > REJECTIONS_GAP_PER_PR, line: `(b) review rejections: ${shown}; gap ${gap.toFixed(2)} (stop above ${REJECTIONS_GAP_PER_PR})` };
}

/** (c): any Haiku worker compacting more than MAX_COMPACTIONS times, or any recorded turn above the prompt ceiling. */
function thrashVerdict(haiku: Summary): Verdict {
  const tripped = haiku.mostCompactions > MAX_COMPACTIONS || haiku.oversize > 0;
  return { id: "c", tripped, line: `(c) thrash or refusal: most compactions by one Haiku worker ${haiku.mostCompactions} (stop above ${MAX_COMPACTIONS}); `
    + `Haiku turns recorded above the prompt ceiling ${haiku.oversize} (stop above 0; a refused turn leaves no record, so this is a floor) (n=${haiku.n})` };
}

/** (d): cost per closed row not at least MIN_SAVING_FRACTION below the others' median. */
function savingVerdict(haiku: Summary, other: Summary): Verdict {
  const floor = (s: Summary): string => (s.floors > 0 ? ` (${s.floors} a floor: an unpriced turn)` : "");
  const shown = `Haiku median $${haiku.medianCostUsd?.toFixed(2) ?? "none"} (n=${haiku.nCost})${floor(haiku)}, others $${other.medianCostUsd?.toFixed(2) ?? "none"} (n=${other.nCost})${floor(other)}`;
  if (haiku.medianCostUsd === null || other.medianCostUsd === null) return { id: "d", tripped: null, line: `(d) cost per closed row: ${shown} -- not readable` };
  const saving = 1 - haiku.medianCostUsd / other.medianCostUsd;
  return { id: "d", tripped: saving < MIN_SAVING_FRACTION, line: `(d) cost per closed row: ${shown}; saving ${(saving * PERCENT).toFixed(0)}% (stop below ${MIN_SAVING_FRACTION * PERCENT}%)` };
}

/** (e): fewer than MIN_ROWS_IN_WINDOW Haiku rows closed in the 72 hours; unreadable until the window has run. */
function tooFewVerdict({ closedInWindow, started, now }: { closedInWindow: number; started: number | null; now: number }): Verdict {
  if (started === null) return { id: "e", tripped: null, line: "(e) too few to read: no Haiku worker has started, so the clock is not running" };
  const open = now < started + WINDOW_HOURS * MS_PER_HOUR;
  const shown = `${closedInWindow} Haiku rows closed since the first worker started ${new Date(started).toISOString()} (stop below ${MIN_ROWS_IN_WINDOW} after ${WINDOW_HOURS} hours)`;
  return { id: "e", tripped: open ? null : closedInWindow < MIN_ROWS_IN_WINDOW, line: `(e) too few to read: ${shown}${open ? " -- the window is still open" : ""}` };
}

/** The stop rule applied: one verdict per condition, `tripped: null` where the figures cannot decide it yet. */
export function stopRule({ haiku, other, closedInWindow, started, now }: { haiku: RowMeasures[]; other: RowMeasures[]; closedInWindow: number; started: number | null; now: number }): Verdict[] {
  const h = summarise(haiku);
  const o = summarise(other);
  return [firstPassVerdict(h, o), rejectionsVerdict(h, o), thrashVerdict(h), savingVerdict(h, o), tooFewVerdict({ closedInWindow, started, now })];
}

/** The earliest time a `tier:haiku` row's Haiku worker took a turn: the clock the 72 hours runs from. */
export function firstHaikuStart(haikuRows: ClosedRow[], events: TraceEvent[]): number | null {
  const numbers = new Set(haikuRows.map((row) => row.number));
  const starts = events.filter((e) => e.kind === "turn" && e.row !== null && numbers.has(e.row) && e.model?.startsWith(HAIKU_MODEL_ID)).map((e) => e.at);
  return starts.length === 0 ? null : Math.min(...starts);
}

/** The closed rows that have no merged pull request for a reason the merge count cannot show: no closing pull request at all, and one whose repository could not be read (agent-org#689). */
export function closersOf(rows: ClosedRow[]): { noPr: number; unresolved: number } {
  return { noPr: rows.filter((row) => row.pr === null && !row.unresolved).length, unresolved: rows.filter((row) => row.unresolved).length };
}

function groupLines(s: Summary, closers: { noPr: number; unresolved: number }): string[] {
  // An unresolved row is NOT a row that did not merge: with any, "none merged" would say what was not measured.
  const none = closers.unresolved > 0 ? `none merged (${closers.unresolved} unresolved, so not a reading)` : "none merged";
  return [`  n=${s.n} closed (${s.nMerged} with a merged pull request, ${closers.noPr} with no closing pull request, ${closers.unresolved} unresolved)`,
    `  first-pass merge: ${s.firstPassRate === null ? none : rateText(s.nMerged, s.firstPassRate)}`,
    `  review rejections per PR: ${s.meanRejections === null ? none : `${s.meanRejections.toFixed(2)} (n=${s.nMerged})`}`,
    `  most compactions by one session: ${s.mostCompactions}`,
    `  cost per closed row, median: ${s.medianCostUsd === null ? "no turns held" : `$${s.medianCostUsd.toFixed(2)} (n=${s.nCost}${s.floors > 0 ? `, ${s.floors} a floor` : ""})`}`,
    `  turns per row, median (not a stop condition): ${s.medianTurns ?? "no rows"} (n=${s.n})`];
}

const EFFORT_ORDER = ["minimal", "low", "medium", "high", "xhigh", "max"];

/** `low` before `high`, an effort this report has no place for after them (alphabetically), then `mixed` and `unknown` last. */
function byEffortOrder(a: string, b: string): number {
  const rank = (effort: string): number => {
    if (effort === EFFORT_UNKNOWN) return EFFORT_ORDER.length + 2;
    if (effort === EFFORT_MIXED) return EFFORT_ORDER.length + 1;
    const known = EFFORT_ORDER.indexOf(effort);
    return known >= 0 ? known : EFFORT_ORDER.length;
  };
  return rank(a) - rank(b) || a.localeCompare(b);
}

/** One line per effort the arm's rows ran at (its own figures, so "at low" and "at high" read apart), and each row's effort beside its number. */
function effortLines(rows: RowMeasures[]): string[] {
  if (rows.length === 0) return ["  effort: no rows"];
  const efforts = [...new Set(rows.map((row) => row.effort))].sort(byEffortOrder);
  const groups = efforts.map((effort) => {
    const group = rows.filter((row) => row.effort === effort);
    const s = summarise(group);
    return `  at ${effort}: ${group.length} rows; first-pass merge ${s.firstPassRate === null ? "none merged" : rateText(s.nMerged, s.firstPassRate)}; `
      + `review rejections per PR ${s.meanRejections === null ? "none merged" : `${s.meanRejections.toFixed(2)} (n=${s.nMerged})`}; `
      + `cost per row, median ${s.medianCostUsd === null ? "no turns held" : `$${s.medianCostUsd.toFixed(2)} (n=${s.nCost})`}`;
  });
  return ["  effort of each row's turns (a row whose turns name none is `unknown`, not `low`):", ...groups,
    `  per row: ${[...rows].sort((a, b) => a.number - b.number).map((row) => `#${row.number} ${row.effort}`).join(", ")}`];
}

/** The whole report as lines. `closed` is every closed row in the window, `events` the store (repriced here). */
export function reportLines({ closed, events, now }: { closed: ClosedRow[]; events: TraceEvent[]; now: number }): string[] {
  const priced = repriceEvents(events);
  const started = firstHaikuStart(closed.filter((row) => row.haiku), priced);
  const inWindow = closed.filter((row) => started !== null && row.closedAt >= started && row.closedAt <= now);
  const measured = inWindow.map((row) => measuresOf(row, priced));
  const haiku = measured.filter((row) => row.haiku);
  const other = measured.filter((row) => !row.haiku);
  const closers = { haiku: closersOf(inWindow.filter((row) => row.haiku)), other: closersOf(inWindow.filter((row) => !row.haiku)) };
  const verdicts = stopRule({ haiku, other, closedInWindow: haiku.length, started, now });
  const verdictText = (v: Verdict): string => `${v.tripped === null ? "UNREADABLE" : v.tripped ? "STOP" : "ok"}  ${v.line}`;
  return [`${HAIKU_TIER_LABEL} trial report (a11ign/a11ign#4382), window from ${started === null ? "no Haiku worker yet" : new Date(started).toISOString()} to ${new Date(now).toISOString()}`,
    `${HAIKU_TIER_LABEL} rows:`, ...groupLines(summarise(haiku), closers.haiku), ...effortLines(haiku),
    "other rows closed in the same window:", ...groupLines(summarise(other), closers.other), ...effortLines(other),
    "stop rule (STOP: set enabled to false in src/haiku-tier.json; UNREADABLE decides nothing):", ...verdicts.map(verdictText)];
}

/** `repository` as `gh issue list --json closedByPullRequestsReferences` returns it: `{id, name, owner: {id, login}}`, with NO `nameWithOwner` (measured 2026-10-09, agent-org#530). */
type GhRepository = { nameWithOwner?: string; name?: string; owner?: { login?: string } };
type GhIssue = { number: number; labels?: { name: string }[]; closedAt: string; closedByPullRequestsReferences?: { number: number; repository?: GhRepository }[] };

/** `owner/name`, the form the store's `gh:<repo>#<n>:` event ids carry. `null` where the repository names neither `nameWithOwner` nor `owner.login` and `name`. */
function repoOf(repository: GhRepository | undefined): string | null {
  if (repository?.nameWithOwner) return repository.nameWithOwner;
  if (repository?.owner?.login && repository.name) return `${repository.owner.login}/${repository.name}`;
  return null;
}

/** One closed row. A closing pull request whose repository cannot be read is kept as `unresolved` with `pr: null`, so the report counts it and prints it (agent-org#689): `null` alone
 * would read as "no pull request" and fold into "none merged", the silent zero agent-org#530 replaced. */
export function closedRowOrUnresolved(issue: GhIssue): ClosedRow {
  const closer = (issue.closedByPullRequestsReferences ?? [])[0];
  const repo = closer ? repoOf(closer.repository) : null;
  return { number: issue.number, haiku: (issue.labels ?? []).some((l) => l.name === HAIKU_TIER_LABEL), closedAt: Date.parse(issue.closedAt),
    pr: closer && repo ? { repo, number: closer.number } : null, unresolved: closer !== undefined && repo === null };
}

/** The strict reader (agent-org#530): a repository it cannot read throws with the row number and the keys seen. The report itself reads rows through `closedRowOrUnresolved`. */
export function closedRowOf(issue: GhIssue): ClosedRow {
  const row = closedRowOrUnresolved(issue);
  if (row.unresolved) throw new Error(`#${issue.number}: its closing pull request names no repository the report can read (keys: ${Object.keys(issue.closedByPullRequestsReferences?.[0]?.repository ?? {}).join(",") || "none"})`);
  return row;
}

/** `gh issue list --limit` is applied to the rows NEWEST CREATED first, and a search reaches at most this many (GitHub's own cap). A read that returns this many may have been cut. */
export const CLOSED_ROWS_LIMIT = 1000;
const MS_PER_SECOND = 1000;

/** The earliest turn the store holds that a Haiku model took. The report's window opens at the first turn of a `tier:haiku` ROW (`firstHaikuStart`), which is this or later, so reading
 * from here reads every row the window needs and, at worst, a few more that `reportLines` then leaves out. `null` where no Haiku turn is held: the clock is not running. */
export function windowStartOf(events: TraceEvent[]): number | null {
  const starts = events.filter((e) => e.kind === "turn" && e.model?.startsWith(HAIKU_MODEL_ID)).map((e) => e.at);
  return starts.length === 0 ? null : Math.min(...starts);
}

/** A second-precision UTC timestamp, the form a `closed:` search qualifier takes. */
const searchTime = (ms: number): string => new Date(Math.floor(ms / MS_PER_SECOND) * MS_PER_SECOND).toISOString().replace(/\.\d{3}Z$/, "Z");

/** The `gh issue list` arguments for the rows CLOSED in `[from, to]`. `--limit` alone returns the newest CREATED, so a row opened before the cut and closed inside the window is
 * never read (agent-org#707); the `closed:` qualifier is what selects by closing time. */
export function closedRowsArgs(from: number, to: number): string[] {
  return ["issue", "list", "--repo", REPO, "--state", "closed", "--search", `closed:${searchTime(from)}..${searchTime(to)}`, "--limit", String(CLOSED_ROWS_LIMIT),
    "--json", "number,labels,closedAt,closedByPullRequestsReferences"];
}

/** Runs `gh` and returns its stdout; injected so a test can stand in for it. */
export type GhRunner = (args: string[]) => string;
const ghOutput: GhRunner = (args) => execFileSync("gh", args, { encoding: "utf8" });

/** Every row closed in `[from, to]`. A read that fills `CLOSED_ROWS_LIMIT` may have been cut, so its range is halved and read again; a one-second range that still fills it throws, rather than
 * report a count short by the rows it left behind. */
function issuesClosedBetween(from: number, to: number, gh: GhRunner): GhIssue[] {
  const issues = JSON.parse(gh(closedRowsArgs(from, to))) as GhIssue[];
  if (issues.length < CLOSED_ROWS_LIMIT) return issues;
  const mid = Math.floor((from + (to - from) / 2) / MS_PER_SECOND) * MS_PER_SECOND;
  if (mid <= Math.floor(from / MS_PER_SECOND) * MS_PER_SECOND) throw new Error(`${CLOSED_ROWS_LIMIT} rows closed within one second at ${searchTime(from)}: the read cannot tell whether it is whole`);
  return [...issuesClosedBetween(from, mid, gh), ...issuesClosedBetween(mid + MS_PER_SECOND, to, gh)];
}

/** The closed rows with their labels and closing pull request, for the rows closed from `from` to `to`. */
export function readClosedRows(from: number, to: number, gh: GhRunner = ghOutput): ClosedRow[] {
  return issuesClosedBetween(from, to, gh).map(closedRowOrUnresolved);
}

function main(): void {
  const flag = process.argv.indexOf("--store");
  const storePath = flag >= 0 ? process.argv[flag + 1] : defaultStore();
  const events = readStore(storePath);
  const now = Date.now();
  const from = windowStartOf(events);
  // No Haiku turn held: the report has no window, so no row is in it and none is read.
  process.stdout.write(`${reportLines({ closed: from === null ? [] : readClosedRows(from, now), events, now }).join("\n")}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) main();
