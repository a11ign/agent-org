// no-token: gh -- no `gh` or file outside a temp directory is touched; the pull requests, reviews, comments and clock are fixtures, and what the reading asks of GitHub is answered by the fake code host's world (a11ign/agent-org#893, A11-160)
// #893: the daily reading of approved pull requests left unqueued over 15 minutes, with the p90 of approval-to-queue, and the incident a count above 0 on two consecutive days files.
//
// EVERY "NOT LISTED" / "NO INCIDENT" ASSERTION HAS A TWIN: the SAME fixture with ONE thing changed that DOES list or file one (`pr`, `reviews` and `seeded` below), so a reading that
// never fires turns the twins red and one that always fires turns the controls red. The mutations, both directions, are in the pull request.
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, afterEach, test } from "node:test";
import { FAILURE_LEDGER_FILE, parseFailureLedger } from "./failure-ledger.ts";
import { forgetActivation, seeded as seededIn, type Seed } from "./plugins/fakes/approved-unqueued-world.test.support.ts";
import {
  APPROVED_UNQUEUED_KIND, MERGED_WINDOW, P90_TARGET_MINUTES, PERSIST_DAYS, READING_ROW, UNQUEUED_MINUTES, approvalToQueueMinutes, approvedSince, countOf, failingCheck, incidentEvents,
  listingOf, p90Of, parseKey, postApprovedUnqueued, readReading, renderReading, repositoryP90, streakEnding, type MergedPr, type OpenPr, type ReviewRead,
} from "./approved-unqueued.ts";

const MIN = 60_000;
const NOW = Date.parse("2026-10-11T12:00:00Z");
const ago = (minutes: number) => new Date(NOW - minutes * MIN).toISOString();
const REPO = "o/home";
const OTHER = "o/other";

const approvedAgo = (minutes: number): ReviewRead[] => [{ state: "APPROVED", submittedAt: ago(minutes) }];
/** An approved, undrafted, unheld, green pull request that was approved `minutes` ago: the fixture every case starts from. */
const pr = (over: Partial<OpenPr> = {}, minutes = 16): OpenPr => ({
  repo: REPO, number: 7, title: "a change", isDraft: false, reviewDecision: "APPROVED", labels: [], reviews: approvedAgo(minutes),
  statusCheckRollup: [{ name: "gate", status: "COMPLETED", conclusion: "SUCCESS" }], ...over,
});
const list = (candidate: OpenPr, { armed = false }: { armed?: boolean } = {}) => listingOf({ pr: candidate, approvedAt: Date.parse(candidate.reviews?.[0].submittedAt as string), armed, now: NOW });

test("the named constants are the row's figures", () => {
  assert.deepEqual([UNQUEUED_MINUTES, P90_TARGET_MINUTES, MERGED_WINDOW, PERSIST_DAYS, READING_ROW], [15, 5, 40, 2, 928]);
});

test("an approved, unarmed, undrafted pull request older than 15 minutes is listed with reason `not armed`", () => {
  const row = list(pr());
  assert.equal(row?.reason, "not armed");
  assert.equal(row?.waitingMinutes, 16);
});

test("one inside 15 minutes is not listed, and exactly 15 is not; one minute more is", () => {
  assert.equal(list(pr({}, 14)), null);
  assert.equal(list(pr({}, 15)), null);
  assert.equal(list(pr({}, 15.5))?.reason, "not armed");
});

test("a held one is listed with reason `hold` naming its holder", () => {
  const row = list(pr({ labels: [{ name: "hold:worker-4970" }, { name: "session:worker-1" }] }));
  assert.equal(row?.reason, "hold");
  assert.deepEqual(row?.holders, ["worker-4970"]);
});

test("a draft is listed with reason `draft`, and a hold on it does not change that", () => {
  assert.equal(list(pr({ isDraft: true }))?.reason, "draft");
  assert.equal(list(pr({ isDraft: true, labels: ["hold:worker-1"] }))?.reason, "draft");
});

test("a failing check is `failing check`; a superseded failed run, a pending one and a green one are `not armed`", () => {
  const red = { name: "gate", status: "COMPLETED", conclusion: "FAILURE", completedAt: ago(10) };
  assert.equal(list(pr({ statusCheckRollup: [red] }))?.reason, "failing check");
  assert.equal(list(pr({ statusCheckRollup: [{ ...red, completedAt: ago(30) }, { name: "gate", status: "COMPLETED", conclusion: "SUCCESS", completedAt: ago(5) }] }))?.reason, "not armed");
  // `red-pr.ts` is the one decider (#2956): the red a hold itself turns is the hold's, and the same red with no hold is a failure.
  const holdsOwn = { name: "deliberateRefusals", status: "COMPLETED", conclusion: "FAILURE", completedAt: ago(10) };
  assert.equal(failingCheck({ statusCheckRollup: [holdsOwn] }), true);
  assert.equal(failingCheck({ labels: [{ name: "hold:worker-1" }], statusCheckRollup: [holdsOwn] }), false);
  assert.equal(failingCheck({ statusCheckRollup: [{ ...red, conclusion: "SUCCESS" }] }), false);
});

test("an armed one is not listed; the same pull request unarmed is", () => {
  assert.equal(list(pr(), { armed: true }), null);
  assert.equal(list(pr(), { armed: false })?.reason, "not armed");
});

test("the approval clock starts at the first approval after the last refusal, and a second approver does not restart it", () => {
  const at = (minutes: number, state: string): ReviewRead => ({ state, submittedAt: ago(minutes) });
  assert.equal(approvedSince([at(50, "APPROVED"), at(20, "APPROVED")]), NOW - 50 * MIN);
  assert.equal(approvedSince([at(50, "APPROVED"), at(40, "CHANGES_REQUESTED"), at(20, "APPROVED")]), NOW - 20 * MIN);
  assert.equal(approvedSince([at(50, "APPROVED"), at(40, "DISMISSED")]), null);
  assert.equal(approvedSince([at(50, "COMMENTED")]), null);
  assert.equal(approvedSince([{ state: "APPROVED", submitted_at: ago(30) }]), NOW - 30 * MIN);
});

test("the p90 is the nearest-rank value, always one that was measured", () => {
  assert.equal(p90Of([]), null);
  assert.equal(p90Of([7]), 7);
  assert.equal(p90Of([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]), 9);
  assert.equal(p90Of([10, 1, 2, 3, 4, 5, 6, 7, 8, 9, 50]), 10);
});

const merged = (number: number, { approvedMin, queuedMin, mergedMin = (queuedMin ?? 0) - 1, reviews }: { approvedMin?: number; queuedMin: number | null; mergedMin?: number; reviews?: ReviewRead[] }): MergedPr => ({
  number, mergedAt: ago(mergedMin),
  reviews: reviews ?? (approvedMin === undefined ? [] : [{ state: "APPROVED", submittedAt: ago(approvedMin) }]),
  queuedAt: queuedMin === null ? [] : [ago(queuedMin)],
});

test("approval-to-queue is measured from the approval to the first queue entry, and what cannot be measured is not a number", () => {
  assert.equal(approvalToQueueMinutes(merged(1, { approvedMin: 100, queuedMin: 93 })), 7);
  assert.equal(approvalToQueueMinutes(merged(2, { approvedMin: 100, queuedMin: null })), null);
  assert.equal(approvalToQueueMinutes(merged(3, { queuedMin: 90 })), null);
  assert.equal(approvalToQueueMinutes({ number: 4, reviews: approvedAgo(90), queuedAt: [ago(95)] }), null); // approved only AFTER the queue entry: no approval stood at it
  assert.equal(approvalToQueueMinutes({ number: 5, reviews: approvedAgo(100), queuedAt: [ago(100)] }), 0);
});

test("the p90 is computed over approval-to-queue and compared against 5 minutes", () => {
  const within = Array.from({ length: 10 }, (_unused, at) => merged(at + 1, { approvedMin: 200 - at * 10, queuedMin: 200 - at * 10 - 3 }));
  const reading = repositoryP90(REPO, within);
  assert.deepEqual([reading.p90Minutes, reading.overTarget, reading.measured, reading.of], [3, false, 10, 10]);
  // the twin: one slow pull request among ten is the 10th value and moves the nearest-rank p90 only when it is the 10th of ten (p90 of 10 is the 9th), so two slow ones do
  const slow = [...within.slice(0, 8), merged(98, { approvedMin: 300, queuedMin: 280 }), merged(99, { approvedMin: 300, queuedMin: 270 })];
  const over = repositoryP90(REPO, slow);
  assert.equal(over.p90Minutes, 20);
  assert.equal(over.overTarget, true);
  assert.equal(repositoryP90(REPO, [merged(1, { approvedMin: 20, queuedMin: 15 })]).overTarget, false); // exactly 5 is within the target
  assert.equal(repositoryP90(REPO, []).overTarget, null);
});

test("only the newest 40 by merge time are in the p90, whatever order they were read in", () => {
  const old = Array.from({ length: 10 }, (_unused, at) => merged(100 + at, { approvedMin: 5000, queuedMin: 4000, mergedMin: 3999 })); // 1000 minutes: far over
  const recent = Array.from({ length: 40 }, (_unused, at) => merged(at + 1, { approvedMin: 300 - at, queuedMin: 297 - at, mergedMin: 296 - at }));
  const reading = repositoryP90(REPO, [...old, ...recent]);
  assert.equal(reading.of, 40);
  assert.equal(reading.p90Minutes, 3);
});

afterEach(() => forgetActivation());
const seeded = (world: Seed = {}) => seededIn({ repo: REPO, now: NOW, readingRow: READING_ROW }, world);

test("a reading lists the unarmed ones, asks for arming only past the threshold, and never for a draft", () => {
  const prs = [pr({ number: 1 }), pr({ number: 2 }, 5), pr({ number: 3, isDraft: true }), pr({ number: 4, labels: ["hold:worker-9"] }), pr({ number: 5 }), pr({ number: 6, reviewDecision: "REVIEW_REQUIRED" })];
  const gh = seeded({ prs, armed: [5] });
  const reading = readReading({ prs, repos: [REPO], now: NOW, run: gh.run });
  assert.deepEqual(reading.listed.map((row) => [row.number, row.reason]).sort(), [[1, "not armed"], [3, "draft"], [4, "hold"]]);
  const armingAsked = gh.asked("armedNodeOf").map((request) => request.number);
  assert.deepEqual(armingAsked.sort(), [1, 4, 5]);
  assert.deepEqual(gh.asked("reviewsOf"), [], "the tick's list carries the reviews, so none is read");
  assert.deepEqual(reading.unread, []);
});

test("a pull request in a repository that is not declared is not read", () => {
  const prs = [pr({ repo: OTHER })];
  const reading = readReading({ prs, repos: [REPO], now: NOW, run: seeded({ prs }).run });
  assert.deepEqual(reading.listed, []);
  assert.equal(readReading({ prs, repos: [REPO, OTHER], now: NOW, run: seeded({ prs }).run }).listed.length, 1);
});

test("an arming read that fails is named unread and is not counted; with nothing else listed the day is `unread`, never 0", () => {
  const gh = seeded({ prs: [pr()] });
  gh.held.failures.set("armedNodeOf", new Error("gh refused: the arming read"));
  const reading = readReading({ prs: [pr()], repos: [REPO], now: NOW, run: gh.run });
  assert.equal(reading.listed.length, 0);
  assert.equal(reading.unread.length, 1);
  assert.equal(countOf(reading), "unread");
  assert.match(renderReading(reading), /count=unread/);
  const young = [pr({}, 5)];
  const clean = readReading({ prs: young, repos: [REPO], now: NOW, run: seeded({ prs: young }).run });
  assert.equal(countOf(clean), 0);
});

test("reviews missing from the tick's list are read once, per candidate", () => {
  const bare = { ...pr(), reviews: undefined };
  const gh = seeded({ prs: [bare] });
  gh.held.pulls.get(7)!.reviews = [{ state: "APPROVED", submittedAt: ago(40) }];
  const reading = readReading({ prs: [bare], repos: [REPO], now: NOW, run: gh.run });
  assert.equal(reading.listed[0]?.waitingMinutes, 40);
  assert.deepEqual(gh.asked("reviewsOf").map((request) => request.number), [7], "read once, for the one candidate that lacked them");
});

test("the comment's first line is its key, and it round-trips", () => {
  const prs = [pr({ number: 1 }), pr({ number: 4, labels: ["hold:worker-9"] })];
  const reading = readReading({ prs, repos: [REPO], now: NOW, run: seeded({ prs }).run });
  const text = renderReading(reading);
  assert.deepEqual(parseKey(text), { day: "2026-10-11", count: 2 });
  assert.match(text, /hold \(worker-9\)/);
  assert.match(text, /p90 approval-to-queue, last 40 merged/);
  assert.equal(parseKey("an ordinary comment"), null);
});

const counts = (entries: [string, number | null][]) => new Map(entries);

test("a count above 0 on two consecutive days files one incident citing both days; a count of 0 between them resets it", () => {
  const events = incidentEvents({ day: "2026-10-11", counts: counts([["2026-10-10", 2], ["2026-10-11", 1]]), repo: REPO });
  assert.equal(events.length, 1);
  assert.equal(events[0].classKey, APPROVED_UNQUEUED_KIND);
  assert.match(events[0].ref, /2026-10-10=2/);
  assert.match(events[0].ref, /2026-10-11=1/);
  // the twin: the same two days with a 0 between them are three days with no two consecutive
  assert.deepEqual(incidentEvents({ day: "2026-10-12", counts: counts([["2026-10-10", 2], ["2026-10-11", 0], ["2026-10-12", 1]]), repo: REPO }), []);
  assert.deepEqual(incidentEvents({ day: "2026-10-11", counts: counts([["2026-10-10", 0], ["2026-10-11", 1]]), repo: REPO }), []);
});

test("a third day of the same wait is not a second incident; a gap, or an unread day, is not a streak", () => {
  const three = counts([["2026-10-09", 1], ["2026-10-10", 1], ["2026-10-11", 1]]);
  assert.equal(streakEnding("2026-10-11", three), 3);
  assert.deepEqual(incidentEvents({ day: "2026-10-11", counts: three, repo: REPO }), []);
  assert.equal(incidentEvents({ day: "2026-10-10", counts: three, repo: REPO }).length, 1);
  assert.deepEqual(incidentEvents({ day: "2026-10-11", counts: counts([["2026-10-09", 3], ["2026-10-11", 1]]), repo: REPO }), []); // 10-10 was never read
  assert.deepEqual(incidentEvents({ day: "2026-10-11", counts: counts([["2026-10-10", null], ["2026-10-11", 1]]), repo: REPO }), []); // 10-10 was `unread`
  assert.equal(streakEnding("2026-10-11", counts([["2026-10-11", 1]])), 1);
});

const dayBody = (day: string, count: number) => `<!-- approved-unqueued: ${day} count=${count} -->\nthe day's reading`;
/** A private directory for the failure ledger, removed after the file's tests (an `rmSync` of each path this file made). */
const made: string[] = [];
after(() => { for (const dir of made) rmSync(dir, { recursive: true, force: true }); });
const scratch = (): string => {
  const dir = mkdtempSync(join(tmpdir(), "approved-unqueued-"));
  made.push(dir);
  return dir;
};
const ledgerIn = (dir: string) => {
  try {
    return parseFailureLedger(readFileSync(join(dir, FAILURE_LEDGER_FILE), "utf8"));
  } catch {
    return [];
  }
};

test("the first post of the day creates ONE comment, and files nothing for a first day", () => {
  const dir = scratch();
  const gh = seeded({ prs: [pr()], merged: [merged(1, { approvedMin: 200, queuedMin: 196 })] });
  const result = postApprovedUnqueued({ prs: [pr()], repos: [REPO], repo: REPO, now: NOW, run: gh.run, logPath: join(dir, FAILURE_LEDGER_FILE) });
  assert.deepEqual([result.posted, (result as any).how, (result as any).count, result.incidents], [true, "created", 1, 0]);
  assert.equal(gh.writes().length, 1);
  assert.deepEqual([gh.writes()[0].op, gh.writes()[0].request.row, gh.writes()[0].request.repo], ["postRowComment", READING_ROW, REPO]);
  assert.match(gh.comments()[0].body, /\| o\/home \| 4\.0 \| 1 of 1 \| within \|/);
  assert.deepEqual(ledgerIn(dir), []);
});

test("a re-run edits the day's comment and does not duplicate it; the tick's own call reads nothing more", () => {
  const dir = scratch();
  const logPath = join(dir, FAILURE_LEDGER_FILE);
  const gh = seeded({ prs: [pr({ number: 1 }), pr({ number: 2 })] });
  postApprovedUnqueued({ prs: [pr({ number: 1 })], repos: [REPO], repo: REPO, now: NOW, run: gh.run, logPath });
  const before = gh.calls.length;
  const again = postApprovedUnqueued({ prs: [pr({ number: 1 })], repos: [REPO], repo: REPO, now: NOW + 2 * MIN, run: gh.run, logPath });
  assert.deepEqual([again.posted, (again as any).why], [false, "already-posted"]);
  assert.deepEqual(gh.calls.slice(before).map((call) => call.op), ["keyedCommentsOf"], "only the comments read: no pull request, arming or merged read");
  const refreshed = postApprovedUnqueued({ prs: [pr({ number: 1 }), pr({ number: 2 })], repos: [REPO], repo: REPO, now: NOW, run: gh.run, logPath, refresh: true });
  assert.deepEqual([refreshed.posted, (refreshed as any).how], [true, "edited"]);
  assert.equal(gh.comments().length, 1, "one comment for the day");
  assert.match(gh.comments()[0].body, /count=2/);
  assert.equal(gh.writes().filter((call) => call.op === "postRowComment").length, 1);
  const same = postApprovedUnqueued({ prs: [pr({ number: 1 }), pr({ number: 2 })], repos: [REPO], repo: REPO, now: NOW, run: gh.run, logPath, refresh: true });
  assert.deepEqual([same.posted, (same as any).why], [false, "unchanged"]);
});

test("two consecutive days above 0 file ONE incident through the failure ledger, once however often it runs", () => {
  const dir = scratch();
  const logPath = join(dir, FAILURE_LEDGER_FILE);
  const gh = seeded({ prs: [pr()], comments: [{ id: 5, body: dayBody("2026-10-10", 2) }] });
  const first = postApprovedUnqueued({ prs: [pr()], repos: [REPO], repo: REPO, now: NOW, run: gh.run, logPath });
  assert.equal(first.incidents, 1);
  postApprovedUnqueued({ prs: [pr()], repos: [REPO], repo: REPO, now: NOW + 2 * MIN, run: gh.run, logPath });
  postApprovedUnqueued({ prs: [pr()], repos: [REPO], repo: REPO, now: NOW + 4 * MIN, run: gh.run, logPath, refresh: true });
  const entries = ledgerIn(dir);
  assert.equal(entries.length, 1);
  assert.equal(entries[0].classKey, APPROVED_UNQUEUED_KIND);
});

test("a 0 day between two days above 0 files nothing", () => {
  const dir = scratch();
  const gh = seeded({ prs: [pr()], comments: [{ id: 5, body: dayBody("2026-10-09", 2) }, { id: 6, body: dayBody("2026-10-10", 0) }] });
  const result = postApprovedUnqueued({ prs: [pr()], repos: [REPO], repo: REPO, now: NOW, run: gh.run, logPath: join(dir, FAILURE_LEDGER_FILE) });
  assert.equal(result.incidents, 0);
  assert.deepEqual(ledgerIn(dir), []);
});

test("a refused open-pull-request list posts nothing: not a 0", () => {
  const dir = scratch();
  const gh = seeded();
  const result = postApprovedUnqueued({ prs: null, repos: [REPO], repo: REPO, now: NOW, run: gh.run, logPath: join(dir, FAILURE_LEDGER_FILE) });
  assert.deepEqual([result.posted, (result as any).why], [false, "unread"]);
  assert.deepEqual(gh.writes(), []);
});

test("a merged read that is refused is `not read` in its repository's row, and the open half is still posted", () => {
  const dir = scratch();
  const gh = seeded({ prs: [pr()] });
  gh.held.failures.set("mergedWindowOf", new Error("gh refused: the merged read"));
  const result = postApprovedUnqueued({ prs: [pr()], repos: [REPO], repo: REPO, now: NOW, run: gh.run, logPath: join(dir, FAILURE_LEDGER_FILE) });
  assert.equal(result.posted, true);
  assert.match(gh.comments()[0].body, /\| o\/home \| unknown \| 0 of 0 \| not read/);
});

test("nothing it reads is changed: the only writes are the day's comment", () => {
  const dir = scratch();
  const prs = [pr(), pr({ number: 2, isDraft: true }), pr({ number: 3, labels: ["hold:worker-1"] })];
  const gh = seeded({ prs, merged: [merged(1, { approvedMin: 200, queuedMin: 190 })] });
  const pulls = JSON.stringify([...gh.held.pulls.values()]);
  postApprovedUnqueued({ prs, repos: [REPO], repo: REPO, now: NOW, run: gh.run, logPath: join(dir, FAILURE_LEDGER_FILE) });
  assert.deepEqual(gh.writes().map((call) => call.op), ["postRowComment"]);
  assert.equal(JSON.stringify([...gh.held.pulls.values()]), pulls, "no pull request was merged, armed, commented on or labelled");
});
