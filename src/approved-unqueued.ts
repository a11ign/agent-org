// @ts-check
// module: THE DAILY READING OF APPROVED PULL REQUESTS LEFT UNQUEUED, with the p90 of approval-to-queue (a11ign/agent-org#893, follow-up to a11ign/a11ign#4970 item 4)
//
// CHAIRMAN, 2026-10-11 (#4970): an approved pull request reaches the merge queue with no agent turn and no wait. #4970 made a `hold:<session>` outlive no holder unseen; what it left
// is the MEASUREMENT. Nothing read, once a day, which approved pull requests sat unqueued and why, so the next wait of this kind would be found by a person noticing.
//
// WHAT THE DAY'S COMMENT ON #928 CARRIES:
//   1. every approved pull request in the declared repositories left unqueued for MORE than {@link UNQUEUED_MINUTES} minutes, with its reason: `draft`, `hold` (naming the holder),
//      `failing check` or `not armed`, in that order of precedence (the first that is true is the one said);
//   2. the p90 of approval-to-queue over the last {@link MERGED_WINDOW} merged pull requests of each repository, against {@link P90_TARGET_MINUTES}.
//   A count above 0 on two CONSECUTIVE days is one ledger incident, class {@link APPROVED_UNQUEUED_KIND}, citing both days' readings.
//
// ARMED IS `pr-armed-state.ts`'S DEFINITION, IMPORTED. "Left unqueued" here means nothing is left to ARM: a pull request with auto-merge enabled or a queue entry is the platform's, and
// a second spelling of that rule is how `pr-armed-state.ts`'s header records three rows going wrong. A draft is not read for it (`gh pr merge --auto` refuses a draft).
//
// READ-ONLY EXCEPT FOR ITS ONE COMMENT. The day's comment is found by a key in its first line (`<!-- approved-unqueued: <UTC day> count=<n> -->`), so a re-run edits it and never
// duplicates it, and the tick, which calls this every two minutes, finds the day posted and reads nothing more, unless the day's text carries a budget refusal, which the next tick with budget re-reads and edits (`refresh` is the manual run's, which edits; #1674). The state is the comment:
// a streak is read from the previous days' own first lines, so nothing local can disagree with the row.
//
// ABSENCE IS NOT ZERO. A list nobody could read posts nothing (never a "0"), a candidate whose arming could not be read is named as UNREAD and is not counted, and a day that is
// `count=unread` is neither above 0 nor a reset: it cannot be cited, so it ends a streak and starts none.
import { realpathSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { FAILURE_LEDGER_FILE, recordFailures, type FailureEvent } from "./failure-ledger.ts";
import { flagValue, refuseUnknownFlags } from "./lib/cli-flags.ts";
import { holdersOf } from "./pr-hold-state.ts";
import { armedFromApi, armedQueryArgs } from "./pr-armed-state.ts";
import { UNQUEUED_MINUTES } from "./org-health.ts";
import { isBrokenRed } from "./red-pr.ts";
import { editComment, keyedCommentsOf, mergedWindowOf, openPullsOf, postRowComment, reviewsOf } from "./ticket-port/approved-unqueued-reads.ts";

const MINUTE_MS = 60_000;
const DAY_MS = 24 * 60 * MINUTE_MS;
const P90 = 0.9;

/** How long an approved pull request may stand unarmed before it is listed. THE ROW'S FIGURE, the one `org-health.ts`'s `approved-unqueued` canary signal already counts by; a pull request at exactly this age is not listed. */
export { UNQUEUED_MINUTES };
/** The target for approval-to-queue (#4970): the p90 is over it when it is MORE than this. */
export const P90_TARGET_MINUTES = 5;
/** How many merged pull requests per repository the p90 is over. */
export const MERGED_WINDOW = 40;
/** How many recently UPDATED merged pull requests are read to find the newest {@link MERGED_WINDOW} by merge time: GraphQL cannot order merged pull requests by `mergedAt`. */
const MERGED_READ = 60;
/** A streak of this many consecutive days with a count above 0 is the incident. */
export const PERSIST_DAYS = 2;
/** The failure-ledger class key, an event kind like `row-not-finishable`; NOT in `FAILURE_KINDS`, for the reason `CHAIRMAN_LABEL_NOT_CHAIRMAN_KIND` (`failure-ledger.ts`) states. */
export const APPROVED_UNQUEUED_KIND = "approved-unqueued";
/** The row the daily reading is posted on, in the home tracker: the one `board-truth-audit.ts`'s table and the DORA block are posted on. */
export const READING_ROW = 928;

const MARKER = "<!-- approved-unqueued: ";
const DAY_LENGTH = 10;
/** A budget refusal INSIDE a day's text (#1674). `BUDGET_REFUSAL` (`unpark-satisfied.ts`) is anchored to a whole message; this one sits in a table cell of the comment, so it is the same words unanchored. */
const BUDGET_IN_TEXT = /gate-budget: refused /;
const budgetRefusedIn = (text: string): boolean => BUDGET_IN_TEXT.test(text);

export const REASONS = Object.freeze(["draft", "hold", "failing check", "not armed"] as const);
export type Reason = (typeof REASONS)[number];

/** One approved pull request as the tick's list reads it (`gh pr list --json`), with `repo` stamped on it. Only the fields named here are read. */
export type OpenPr = {
  repo: string; number: number; title?: string; isDraft?: boolean; reviewDecision?: string | null;
  labels?: ({ name?: string } | string)[]; statusCheckRollup?: any[]; reviews?: ReviewRead[];
};
export type ReviewRead = { state?: string; submittedAt?: string | null; submitted_at?: string | null };
export type Unqueued = { repo: string; number: number; title: string; reason: Reason; holders: string[]; approvedAt: number; waitingMinutes: number };
export type Unread = { repo: string; number: number; why: string };
export type RepositoryP90 = { repo: string; measured: number; of: number; p90Minutes: number | null; overTarget: boolean | null; why?: string };
export type Reading = { day: string; listed: Unqueued[]; unread: Unread[]; p90: RepositoryP90[] };

const utcDay = (at: number): string => new Date(at).toISOString().slice(0, DAY_LENGTH);
const labelNames = (pr: OpenPr): string[] => (pr.labels ?? []).map((label) => (typeof label === "string" ? label : String(label?.name ?? "")));
const submittedOf = (review: ReviewRead): number => Date.parse(String(review?.submittedAt ?? review?.submitted_at ?? ""));

/**
 * WHEN THE PULL REQUEST BECAME APPROVED: the first APPROVED review after the last verdict that took the approval away (CHANGES_REQUESTED or DISMISSED), so a second approver
 * arriving later does not restart the clock and a re-approval after a refusal does. `until` ends the walk (the queue entry, for a merged pull request). `null` is "no approval
 * stands in what was read", which is not a time.
 */
export function approvedSince(reviews: ReviewRead[] | null | undefined, { until = Infinity }: { until?: number } = {}): number | null {
  const dated = (reviews ?? []).map((review) => ({ state: String(review?.state ?? "").toUpperCase(), at: submittedOf(review) }))
    .filter(({ at }) => Number.isFinite(at) && at <= until)
    .sort((a, b) => a.at - b.at);
  let since: number | null = null;
  for (const { state, at } of dated) {
    if (state === "APPROVED") since ??= at;
    else if (state === "CHANGES_REQUESTED" || state === "DISMISSED") since = null;
  }
  return since;
}

/**
 * Whether a check has FAILED on the newest run of its name and nothing excuses it: `red-pr.ts`'s one decider (#2956), so a hold's own deliberate red is the hold's and a
 * superseded failed run is not a failure. Pending and skipped are not red.
 */
export const failingCheck = (pr: Pick<OpenPr, "labels" | "statusCheckRollup">): boolean => isBrokenRed(pr);

/**
 * PURE. The listing for ONE approved pull request, or `null` when it is not one: inside the {@link UNQUEUED_MINUTES} (exactly that age included) or already armed. `armed` is
 * `null` for a read nobody could make, which is the caller's to say as unread and is never a listing. A draft is never read for arming, so it passes `false`.
 */
export function listingOf({ pr, approvedAt, armed, now }: { pr: OpenPr; approvedAt: number; armed: boolean; now: number }): Unqueued | null {
  const waitingMs = now - approvedAt;
  if (!(waitingMs > UNQUEUED_MINUTES * MINUTE_MS) || armed) return null;
  const holders = holdersOf(labelNames(pr)).map((label) => label.slice("hold:".length));
  const reason: Reason = pr.isDraft === true ? "draft" : holders.length > 0 ? "hold" : failingCheck(pr) ? "failing check" : "not armed";
  return { repo: pr.repo, number: pr.number, title: pr.title ?? "", reason, holders, approvedAt, waitingMinutes: Math.floor(waitingMs / MINUTE_MS) };
}

/** NEAREST-RANK p90 (the value at ceil(0.9 n) of the sorted list), so it is always a measured value and never an interpolated one; `null` for none. */
export function p90Of(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.max(0, Math.ceil(sorted.length * P90) - 1)];
}

/** A merged pull request as the daily read returns it. */
export type MergedPr = { number: number; mergedAt?: string | null; reviews?: ReviewRead[]; queuedAt?: (string | null)[] };

/**
 * PURE. Approval-to-queue of ONE merged pull request in minutes, or `null` when it cannot be measured: no queue entry (merged by hand, not through the queue), or no approval at
 * or before the first one. A negative interval is not a wait (auto-merge enabled, then approved, then queued by the platform at the approval), so it reads 0.
 * The clock STARTS at the approval and so includes a check that was still running at the approval: the row's figure is approval-to-queue, and says so in the comment.
 */
export function approvalToQueueMinutes(pr: MergedPr): number | null {
  const queued = (pr.queuedAt ?? []).map((at) => Date.parse(String(at ?? ""))).filter(Number.isFinite).sort((a, b) => a - b)[0];
  if (queued === undefined) return null;
  const approved = approvedSince(pr.reviews, { until: queued });
  return approved === null ? null : Math.max(0, (queued - approved) / MINUTE_MS);
}

/** PURE. The p90 of the newest {@link MERGED_WINDOW} merged pull requests of one repository, with how many of them could be measured. */
export function repositoryP90(repo: string, merged: MergedPr[]): RepositoryP90 {
  const newest = [...merged].filter((pr) => Number.isFinite(Date.parse(String(pr.mergedAt ?? ""))))
    .sort((a, b) => Date.parse(String(b.mergedAt)) - Date.parse(String(a.mergedAt))).slice(0, MERGED_WINDOW);
  const minutes = newest.map(approvalToQueueMinutes).filter((value): value is number => value !== null);
  const p90Minutes = p90Of(minutes);
  return { repo, measured: minutes.length, of: newest.length, p90Minutes, overTarget: p90Minutes === null ? null : p90Minutes > P90_TARGET_MINUTES };
}

type Run = (args: string[]) => string;

/** One repository's p90, `null`-valued with the reason when the read was refused: an unreadable window is unread and never a 0. */
export function readRepositoryP90(repo: string, run: Run): RepositoryP90 {
  try {
    const nodes = mergedWindowOf({ repo, window: MERGED_READ, run });
    if (!Array.isArray(nodes)) throw new Error("the merged list is not a list");
    return repositoryP90(repo, nodes);
  } catch (error) {
    return { repo, measured: 0, of: 0, p90Minutes: null, overTarget: null, why: String((error as Error)?.message ?? error).split("\n")[0].slice(0, 120) };
  }
}

/**
 * THE READING of one day over the open pull requests `prs` the tick already holds (`null` entries are not in it: a refused list is the caller's to refuse before this).
 * Per approved candidate: its approval time from the `reviews` the list carries (the REST read is the fallback for a payload without them), then, only for one past the
 * threshold and not a draft, ONE arming read. The p90 is one merged read per repository.
 */
export function readReading({ prs, repos, now, run }: { prs: OpenPr[]; repos: string[]; now: number; run: Run }): Reading {
  const listed: Unqueued[] = [];
  const unread: Unread[] = [];
  for (const pr of prs.filter((candidate) => repos.includes(candidate.repo) && candidate.reviewDecision === "APPROVED")) {
    try {
      const reviews = Array.isArray(pr.reviews) ? pr.reviews : reviewsOf({ repo: pr.repo, number: pr.number, run });
      const approvedAt = approvedSince(reviews);
      if (approvedAt === null) { unread.push({ repo: pr.repo, number: pr.number, why: "no approving review in what was read" }); continue; }
      if (!(now - approvedAt > UNQUEUED_MINUTES * MINUTE_MS)) continue;
      let armed = false;
      if (pr.isDraft !== true) {
        const node = JSON.parse(run(armedQueryArgs({ number: pr.number, repo: pr.repo })));
        if (node === null || typeof node !== "object") throw new Error("the arming read returned no pull request");
        armed = armedFromApi(node);
      }
      const row = listingOf({ pr, approvedAt, armed, now });
      if (row !== null) listed.push(row);
    } catch (error) {
      unread.push({ repo: pr.repo, number: pr.number, why: String((error as Error)?.message ?? error).split("\n")[0].slice(0, 120) });
    }
  }
  listed.sort((a, b) => b.waitingMinutes - a.waitingMinutes);
  return { day: utcDay(now), listed, unread, p90: repos.map((repo) => readRepositoryP90(repo, run)) };
}

/** The day's count as the first line carries it: a number, or `unread` for a day with nothing listed that could not be fully read. */
export const countOf = (reading: Reading): number | "unread" => (reading.listed.length === 0 && reading.unread.length > 0 ? "unread" : reading.listed.length);

const minutesText = (minutes: number): string => (minutes < 10 ? minutes.toFixed(1) : String(Math.round(minutes)));
const cell = (text: string): string => text.replaceAll("|", "\\|").replaceAll("\n", " ");
const link = (row: { repo: string; number: number }): string => `${row.repo}#${row.number}`;

/** The comment: its first line is the KEY and the count, so the next day's streak is read from the row itself. */
export function renderReading(reading: Reading): string {
  const count = countOf(reading);
  const lines = [`${MARKER}${reading.day} count=${count} -->`,
    `### Approved pull requests left unqueued, ${reading.day} (UTC)`, "",
    `**${count === "unread" ? "Not known" : count} approved pull request${count === 1 ? "" : "s"} unarmed more than ${UNQUEUED_MINUTES} minutes after approval.**`];
  if (reading.listed.length > 0) {
    lines.push("", "| Pull request | Waiting (min) | Reason |", "| --- | --- | --- |",
      ...reading.listed.map((row) => `| ${link(row)} ${cell(row.title)} | ${row.waitingMinutes} | ${row.reason}${row.holders.length > 0 ? ` (${row.holders.join(", ")})` : ""} |`));
  }
  if (reading.unread.length > 0) lines.push("", `Not read, so not counted: ${reading.unread.map((row) => `${link(row)} (${cell(row.why)})`).join("; ")}.`);
  lines.push("", `**p90 approval-to-queue, last ${MERGED_WINDOW} merged pull requests per repository, against a target of ${P90_TARGET_MINUTES} minutes or less:**`, "",
    "| Repository | p90 (min) | Measured | Against target |", "| --- | --- | --- | --- |",
    ...reading.p90.map((row) => `| ${row.repo} | ${row.p90Minutes === null ? "unknown" : minutesText(row.p90Minutes)} | ${row.measured} of ${row.of} | ${
      row.overTarget === null ? `not read${row.why === undefined ? "" : ` (${cell(row.why)})`}` : row.overTarget ? "OVER" : "within"} |`));
  lines.push("", "_The clock runs from the approval to the first queue entry, so a check still running at the approval is in it. A merged pull request with no queue entry is not measured._",
    "_Read once a day by the work-gate tick (a11ign/agent-org#893); read-only, and a re-run edits this comment._");
  return lines.join("\n");
}

/** `{ day, count }` of a comment body's first line, or `null` when it is not one of these. `count` is `null` for `unread`. */
export function parseKey(body: string): { day: string; count: number | null } | null {
  const match = /^<!-- approved-unqueued: (\d{4}-\d{2}-\d{2}) count=(\d+|unread) -->/.exec(body);
  return match === null ? null : { day: match[1], count: match[2] === "unread" ? null : Number(match[2]) };
}

const dayBefore = (day: string, days: number): string => utcDay(Date.parse(`${day}T00:00:00Z`) - days * DAY_MS);

/**
 * PURE. How many CONSECUTIVE days, ending at `day`, have a count above 0, from the counts the row holds (`day -> count`, `null` for `unread`). A missing day or an `unread` one
 * ends the run, because a day that cannot be cited is not a reading and neither is it a 0.
 */
export function streakEnding(day: string, counts: ReadonlyMap<string, number | null>): number {
  let streak = 0;
  for (let at = day; ; at = dayBefore(at, 1)) {
    const count = counts.get(at);
    if (count === undefined || count === null || count === 0) return streak;
    streak += 1;
  }
}

/**
 * PURE. THE INCIDENT: exactly when the run ending today REACHES {@link PERSIST_DAYS}, so one standing wait is one incident and not one a day. The ref cites each day's reading as
 * `<repo>#<row>@<day>=<count>`, and `recordFailures` skips a (class, ref) it holds, so a re-run of the same day appends nothing twice.
 */
export function incidentEvents({ day, counts, repo }: { day: string; counts: ReadonlyMap<string, number | null>; repo: string }): FailureEvent[] {
  if (streakEnding(day, counts) !== PERSIST_DAYS) return [];
  const cited = Array.from({ length: PERSIST_DAYS }, (_unused, at) => dayBefore(day, PERSIST_DAYS - 1 - at))
    .map((each) => `${repo}#${READING_ROW}@${each}=${counts.get(each)}`);
  return [{ classKey: APPROVED_UNQUEUED_KIND, ref: cited.join(",") }];
}

export type PostResult =
  | { posted: true; how: "created" | "edited"; day: string; count: number | "unread"; incidents: number }
  | { posted: false; why: "already-posted" | "unchanged" | "unread"; day: string; incidents: number; detail?: string };

/**
 * THE DAY'S POST. `prs` is the tick's own list across the declared repositories (`null` is a refused read: nothing is posted, never a 0). With the day's comment already on the row
 * and `refresh` false it reads nothing more and files only what the comments themselves say; with `refresh` it reads, and EDITS the comment when its text changed.
 * A day's comment whose text carries a budget refusal is NOT "already posted" (#1674): the tick that has budget reads it again and edits it. A day whose text still carries
 * one when the NEXT day's tick runs has ended with it, so its key is stamped `unread` and it ends a streak as any day that cannot be cited does.
 * A failed ledger write or comment is thrown to the caller, which says so: a post that could not tell whether the day's comment is there must not guess.
 */
export function postApprovedUnqueued({ prs, repos, repo, now, run, logPath, refresh = false }:
  { prs: OpenPr[] | null; repos: string[]; repo: string; now: number; run: Run; logPath: string; refresh?: boolean }): PostResult {
  const day = utcDay(now);
  const keyed = keyedCommentsOf({ repo, row: READING_ROW, marker: MARKER, since: `${dayBefore(day, PERSIST_DAYS)}T00:00:00Z`, run });
  const counts = new Map<string, number | null>();
  for (const { body } of keyed) { const key = parseKey(body); if (key !== null) counts.set(key.day, key.count); }
  const yesterday = dayBefore(day, 1);
  const ended = keyed.find(({ body }) => parseKey(body)?.day === yesterday);
  if (ended !== undefined && budgetRefusedIn(ended.body) && parseKey(ended.body)?.count !== null) {
    editComment({ repo, id: ended.id, body: ended.body.replace(/^(<!-- approved-unqueued: \S+) count=\d+ -->/, "$1 count=unread -->"), run });
    counts.set(yesterday, null);
  }
  const today = keyed.find(({ body }) => parseKey(body)?.day === day);
  const file = (): number => {
    const events = incidentEvents({ day, counts, repo });
    return recordFailures({ logPath, events, now }).appended;
  };
  if (today !== undefined && !refresh && !budgetRefusedIn(today.body)) return { posted: false, why: "already-posted", day, incidents: file() };
  if (prs === null) return { posted: false, why: "unread", day, incidents: 0, detail: "the open pull-request list was refused" };
  const reading = readReading({ prs, repos, now, run });
  const text = renderReading(reading);
  counts.set(day, parseKey(text)?.count ?? null);
  const incidents = file();
  if (today === undefined) {
    postRowComment({ repo, row: READING_ROW, body: text, run });
    return { posted: true, how: "created", day, count: countOf(reading), incidents };
  }
  if (today.body === text) return { posted: false, why: "unchanged", day, incidents };
  editComment({ repo, id: today.id, body: text, run });
  return { posted: true, how: "edited", day, count: countOf(reading), incidents };
}

/**
 * THE TICK'S ONE LINE: `approvedUnqueuedNow({ prs, repos, repo, stateDir })`. NEVER THROWS and returns nothing, so it cannot stop a tick or add an order: a failure is said on
 * stderr and the next tick asks again, since the row is the state. `prs` are as the gate read them; one without a `repo` is the home repository's.
 */
export function approvedUnqueuedNow({ prs, repos, repo, stateDir, now = Date.now(), run, refresh = false }:
  { prs: any[] | null; repos: string[]; repo: string; stateDir: string; now?: number; run: Run; refresh?: boolean }): PostResult | null {
  try {
    const logPath = `${stateDir}/${FAILURE_LEDGER_FILE}`;
    return postApprovedUnqueued({ prs: prs === null ? null : prs.map((pr) => ({ ...pr, repo: pr.repo ?? repo })), repos, repo, now, run, logPath, refresh });
  } catch (error) {
    process.stderr.write(`approved-unqueued: the day's reading was not posted (${String((error as Error)?.message ?? error).split("\n")[0]}); the next tick asks again\n`);
    return null;
  }
}

// THE CLI: `node src/approved-unqueued.ts [--refresh] [--dry-run]`, for the manual run and the live reading. It runs through the gate's own runner (`defaultRun`: the host's cache and the
// pool's accounting), imported when it is asked for, and reads the open list itself with the fields the tick's list carries.
/** The fields of an open pull request the reading classifies on: review state for the approval clock, the labels for a hold, the rollup for a failing check. */
const OPEN_FIELDS = "number,title,isDraft,labels,reviewDecision,reviews,statusCheckRollup";

async function main(): Promise<void> {
  refuseUnknownFlags(["--refresh", "--dry-run", "--repo="], { entry: import.meta.url, command: "node src/approved-unqueued.ts" });
  const { homeProjectDeclaration } = await import("./project-config.ts");
  const { stateEntryPath } = await import("./host-config.ts");
  const { defaultRun } = await import("./work-gate.ts");
  const declaration = homeProjectDeclaration();
  const repo = flagValue(process.argv, "repo") ?? declaration.repo;
  const repos = [...new Set(declaration.tracker.map((tracker) => tracker.repo))];
  const now = Date.now();
  const prs = repos.flatMap((each) => (openPullsOf({ repo: each, fields: OPEN_FIELDS, run: defaultRun }) as any[]).map((pr) => ({ ...pr, repo: each })));
  if (process.argv.includes("--dry-run")) {
    process.stdout.write(`${renderReading(readReading({ prs, repos, now, run: defaultRun }))}\n`);
    return;
  }
  const result = postApprovedUnqueued({ prs, repos, repo, now, run: defaultRun, logPath: stateEntryPath(FAILURE_LEDGER_FILE), refresh: process.argv.includes("--refresh") });
  process.stdout.write(`${JSON.stringify(result)}\n`);
}

if (import.meta.url === pathToFileURL(process.argv[1] ? realpathSync(process.argv[1]) : "").href) {
  // NOT a top-level `await`: `main` imports `work-gate.ts` for its runner, which imports this module, and a module awaiting its own importer never settles.
  main().catch((error) => {
    process.stderr.write(`approved-unqueued: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
