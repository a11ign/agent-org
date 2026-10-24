// no-token: gh -- no `gh` or file outside a temp directory is touched; the reads are the fake code host's world, and the source tree is only read (a11ign/agent-org#1674, A11-160)
// #1674: a daily reading that met a budget refusal was filed as a finished day, so its p90 was never asked again. A day whose text carries the refusal is asked again by the next
// tick that has budget, and a day that is still refused when the next day's tick runs is stamped `unread` in its key and ends a streak.
//
// EVERY "STAMPED" / "ASKED AGAIN" ASSERTION HAS A TWIN: the SAME fixture with the refusal taken out, which is posted once and never read again, and whose streak files.
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { after, afterEach, test } from "node:test";
import { FAILURE_LEDGER_FILE, parseFailureLedger } from "../failure-ledger.ts";
import { APPROVED_UNQUEUED_KIND, READING_ROW, type MergedPr, type OpenPr, type ReviewRead, postApprovedUnqueued } from "../approved-unqueued.ts";
import { forgetActivation, seeded as seededIn, type Seed } from "../plugins/fakes/approved-unqueued-world.test.support.ts";

const MIN = 60_000;
const NOW = Date.parse("2026-10-11T12:00:00Z");
const ago = (minutes: number) => new Date(NOW - minutes * MIN).toISOString();
const REPO = "o/home";
const SRC = fileURLToPath(new URL("..", import.meta.url));
/** The words `gh-conditional.ts` refuses a read past the tick's cap with (`BUDGET_REFUSAL` in `unpark-satisfied.ts`). */
const BUDGET_MESSAGE = "gate-budget: refused `gh api graphql` at 53/60 points";

const approvedAgo = (minutes: number): ReviewRead[] => [{ state: "APPROVED", submittedAt: ago(minutes) }];
/** An approved, undrafted, unheld pull request approved `minutes` ago and not armed: listed once it is past 15 minutes. */
const pr = (over: Partial<OpenPr> = {}, minutes = 16): OpenPr => ({
  repo: REPO, number: 7, title: "a change", isDraft: false, reviewDecision: "APPROVED", labels: [], reviews: approvedAgo(minutes),
  statusCheckRollup: [{ name: "gate", status: "COMPLETED", conclusion: "SUCCESS" }], ...over,
});
/** A merged pull request approved 200 minutes before `NOW` and queued 197 minutes before it: 3 minutes approval-to-queue. */
const measured: MergedPr = { number: 1, mergedAt: ago(196), reviews: approvedAgo(200), queuedAt: [ago(197)] };

/** A day's comment as the reading writes it: the key line, then the day's text, which carries the refusal in a cell when `refused` (as `readRepositoryP90` names it). */
const dayReading = (day: string, count: number, refused = false) => `<!-- approved-unqueued: ${day} count=${count} -->\n### Approved pull requests left unqueued, ${day} (UTC)\n\n`
  + `| o/home | unknown | 0 of 0 | not read${refused ? ` (${BUDGET_MESSAGE})` : ""} |`;

afterEach(() => forgetActivation());
/** The fake code host's world: the comments on #928 are the row's, every write lands in them, and a refused merged read is the world's `mergedWindowOf` failing for budget as the gate's cap does. */
const seeded = (world: Seed = {}) => {
  const gh = seededIn({ repo: REPO, now: NOW, readingRow: READING_ROW }, world);
  const refuseMerged = (refused: boolean) => { if (refused) gh.held.failures.set("mergedWindowOf", new Error(BUDGET_MESSAGE)); else gh.held.failures.delete("mergedWindowOf"); };
  return { ...gh, refuseMerged };
};

/** A private directory for the failure ledger, removed after the file's tests. */
const made: string[] = [];
after(() => { for (const dir of made) rmSync(dir, { recursive: true, force: true }); });
const scratch = (): string => {
  const dir = mkdtempSync(join(tmpdir(), "approved-unqueued-budget-"));
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

test("a day whose p90 read was refused is asked again by the next tick with budget: the comment is EDITED to carry the p90, and its count is unchanged", () => {
  const dir = scratch();
  const logPath = join(dir, FAILURE_LEDGER_FILE);
  const gh = seeded({ prs: [pr()], merged: [measured] });
  gh.refuseMerged(true);
  const first = postApprovedUnqueued({ prs: [pr()], repos: [REPO], repo: REPO, now: NOW, run: gh.run, logPath });
  assert.deepEqual([first.posted, (first as any).how, (first as any).count], [true, "created", 1]);
  assert.match(gh.comments()[0].body, /count=1 -->/);
  assert.match(gh.comments()[0].body, /\| o\/home \| unknown \| 0 of 0 \| not read \(gate-budget: refused /);

  gh.refuseMerged(false);
  const again = postApprovedUnqueued({ prs: [pr()], repos: [REPO], repo: REPO, now: NOW + 2 * MIN, run: gh.run, logPath });
  assert.deepEqual([again.posted, (again as any).how, (again as any).count], [true, "edited", 1], "asked again, not `already-posted`");
  assert.equal(gh.comments().length, 1, "still one comment for the day");
  assert.match(gh.comments()[0].body, /^<!-- approved-unqueued: 2026-10-11 count=1 -->/, "the key's count is unchanged");
  assert.match(gh.comments()[0].body, /\| o\/home \| 3\.0 \| 1 of 1 \| within \|/);
  assert.doesNotMatch(gh.comments()[0].body, /gate-budget/);
});

test("twin: a day whose comment carries no refusal is `already-posted` on the next tick, and that tick reads nothing", () => {
  const dir = scratch();
  const logPath = join(dir, FAILURE_LEDGER_FILE);
  const gh = seeded({ prs: [pr()], merged: [measured] });
  postApprovedUnqueued({ prs: [pr()], repos: [REPO], repo: REPO, now: NOW, run: gh.run, logPath });
  const before = gh.calls.length;
  const again = postApprovedUnqueued({ prs: [pr()], repos: [REPO], repo: REPO, now: NOW + 2 * MIN, run: gh.run, logPath });
  assert.deepEqual([again.posted, (again as any).why], [false, "already-posted"]);
  assert.deepEqual(gh.calls.slice(before).map((call) => call.op), ["keyedCommentsOf"], "only the comments are read");
  assert.deepEqual(gh.writes().filter((call) => call.op === "postRowComment").length, 1);
});

test("a day still refused when the NEXT day's tick runs is stamped `unread` in its key, and that ends its streak", () => {
  const dir = scratch();
  const logPath = join(dir, FAILURE_LEDGER_FILE);
  // 10-10 had 2 unarmed and its p90 was refused; 10-11 has 1 unarmed, so without the stamp the streak is two days and an incident files.
  const gh = seeded({ prs: [pr()], comments: [{ id: 5, body: dayReading("2026-10-10", 2, true) }] });
  gh.refuseMerged(true);
  const result = postApprovedUnqueued({ prs: [pr()], repos: [REPO], repo: REPO, now: NOW, run: gh.run, logPath });
  assert.equal(result.incidents, 0);
  assert.deepEqual(ledgerIn(dir), []);
  assert.match(gh.comments()[0].body, /^<!-- approved-unqueued: 2026-10-10 count=unread -->/, "yesterday is stamped unread");
  assert.match(gh.comments()[0].body, /\| o\/home \| unknown \| 0 of 0 \| not read \(gate-budget: refused /, "the text is kept as it was");
  assert.match(gh.comments()[1].body, /^<!-- approved-unqueued: 2026-10-11 count=1 -->/);

  postApprovedUnqueued({ prs: [pr()], repos: [REPO], repo: REPO, now: NOW + 2 * MIN, run: gh.run, logPath });
  const stamped = gh.writes().filter((call) => call.op === "editComment" && call.request.id === 5);
  assert.equal(stamped.length, 1, "yesterday is stamped once, not on every tick");
});

test("twin: the same day with NO refusal in it is not stamped, and its streak of two days files one incident", () => {
  const dir = scratch();
  const logPath = join(dir, FAILURE_LEDGER_FILE);
  const gh = seeded({ prs: [pr()], comments: [{ id: 5, body: dayReading("2026-10-10", 2) }] });
  gh.refuseMerged(true);
  const result = postApprovedUnqueued({ prs: [pr()], repos: [REPO], repo: REPO, now: NOW, run: gh.run, logPath });
  assert.equal(result.incidents, 1);
  assert.equal(ledgerIn(dir)[0]?.classKey, APPROVED_UNQUEUED_KIND);
  assert.deepEqual(gh.writes().filter((call) => call.op === "editComment"), []);
  assert.match(gh.comments()[0].body, /^<!-- approved-unqueued: 2026-10-10 count=2 -->/);
});

test("the daily readers that key a comment by day are derived from the tree, and each is named with whether it has a budget-refusal path", () => {
  // A reader keys its comment by a day when one of its lines writes a `<!-- name: ` marker and another writes the day into a comment (`-->` and the word `day` on one line).
  // The file's own name is excluded: this file is a test and the walk skips tests.
  const files = readdirSync(SRC, { recursive: true }).map(String).filter((file) => file.endsWith(".ts") && !file.endsWith(".test.ts"));
  const readers = files.flatMap((file) => {
    const text = readFileSync(join(SRC, file), "utf8");
    const markers = [...new Set([...text.matchAll(/<!-- ([a-z][a-z0-9-]*): /g)].map((match) => match[1]))];
    const writesDay = text.split("\n").some((line) => !/^\s*(\/\/|\*)/.test(line) && line.includes("-->") && /\bday\b/i.test(line));
    if (markers.length === 0 || !writesDay) return [];
    const budgetPath = /BUDGET_REFUSAL|budgetRefusedIn|gate-budget: refused/.test(text);
    return markers.map((marker) => ({ file, marker, budgetPath }));
  });
  console.log(`daily-keyed readers (${readers.length}):\n${readers.map((row) => `  ${row.file} <!-- ${row.marker} --> budget-refusal path: ${row.budgetPath ? "yes" : "NO"}`).join("\n")}`);
  assert.ok(readers.some((row) => row.marker === "approved-unqueued" && row.budgetPath), "positive control: this reader is found, and has its path");
  assert.ok(readers.length >= 2, "more than this one reader is found, so the walk is not empty");
});
