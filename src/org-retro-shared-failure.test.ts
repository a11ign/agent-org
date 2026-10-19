// no-token: gh -- `buildReport` takes every read as a value, and the closed-row read is a seam; nothing here reaches `gh`
/**
 * agent-org#997 (split from #5098): THE RETRO COUNTS THE SHARED-FAILURE HOLDS THE GATE RELEASED AND THE INCIDENTS CLOSED AS "NOT THE SAME FAILURE". The gate's
 * `ci-shared-failure` lines say when a red PR was held and when it was released, and a closed incident row says when its closer found the red was not the same
 * failure. Neither was counted, so the chairman could not see how often a shared-failure hold had wrongly grouped two failures.
 *
 * Every figure is checked by hand against the fixtures below. The window is the 24 hours before `NOW`. Inside it:
 *   held 42, released 42 (closed)          one wake, PR 42
 *   held 7 and 8, released 7 (expired)     one wake, PR 7 (PR 8 is never released, so it is no wake)
 * and the closed row #900 (closed an hour ago, comment "Not the same failure: ...") is one closure.
 */
import { test } from "node:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import assert from "node:assert/strict";
import * as retro_0 from "./org-retro/readings.ts";
import * as retro_1 from "./org-retro.ts";
import * as retro_2 from "./org-retro/retro-cause.ts";
import { FAILURE_LEDGER_FILE, recordFailures } from "./failure-ledger.ts";
import { underspecifiedReading } from "./spec-lint.ts";
import { tmpDir } from "./lib/tmp-fixture.ts";
import { moduleSource } from "./lib/module-source.ts";

const NOW = Date.parse("2026-10-12T00:22:00Z");
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const WAKES = "- Red PRs a shared-failure incident held and then released (24h)";
const CLOSED = "- Shared-failure incidents closed as \"not the same failure\" (24h)";
const NOT_SAME = "Not the same failure: control#53 and control#58 failed in different steps, so one hold was wrong.";

/** The gate's lines, built with the same words `ci-failure-class.ts` writes; the source pin below checks those words are still the gate's. */
const holding = (...subjects: string[]) => `ci-shared-failure: holding ${subjects.length} red order(s) of a shared failure:${subjects.map((s) => ` ${s}`).join("")}`;
const released = (...pairs: [string, string][]) => `ci-shared-failure: released ${pairs.length} red order(s), their hold is over:${pairs.map(([s, why]) => ` ${s} (${why})`).join("")}`;

/** The tick journal's lines in `journalctl -o short-iso` shape, each `ago` milliseconds before `NOW`. */
const journalOf = (entries: [number, string][]): string => entries
  .map(([ago, message]) => `${new Date(NOW - ago).toISOString().replace(/\.\d{3}Z$/, "+00:00")} host a11ign-work-tick[1]: ${message}`)
  .join("\n");

/** A closed shared-failure row as `org-retro.ts` reads it: its number, closing time and comments. */
const closedRow = (number: number, closedAgo: number, body: string) => ({ number, closedAt: new Date(NOW - closedAgo).toISOString(), comments: [{ body }] });

/** Everything `buildReport` needs besides the journal and the closed rows, so a test varies only those. */
const rest = { merged: [], openPrs: [], journal: "", ledger: "", turns: [], handFixes: null, underspecified: underspecifiedReading([]), closedSharedRows: [] };
const reportOf = (over: object) => retro_0.buildReport({ ...rest, ...over } as any, NOW);
const linesOf = (over: object) => {
  const lines = retro_1.renderReport(reportOf(over)).split("\n");
  return [lines.find((line) => line.startsWith(WAKES)), lines.find((line) => line.startsWith(CLOSED))];
};

test("one hold followed by its release for the same PR reads 1, and a window with no hold reads 0", () => {
  const one = journalOf([[2 * HOUR, holding("42")], [HOUR, released(["42", "closed"])]]);
  assert.deepEqual(linesOf({ journal: one }), [`${WAKES}: 1; first: 42`, `${CLOSED}: 0`],
    "one PR held then released is one wake, and the closed-row count is 0 with no closed rows");
  assert.deepEqual(linesOf({ journal: "" }), [`${WAKES}: 0`, `${CLOSED}: 0`], "a window with no hold reads 0, not a missing line");
});

test("a hold with no release in the window is not a wake, and neither is a release whose hold began before the window", () => {
  assert.deepEqual(linesOf({ journal: journalOf([[HOUR, holding("42")]]) }), [`${WAKES}: 0`, `${CLOSED}: 0`], "held and still held: no release yet");
  const before = journalOf([[25 * HOUR, holding("42")], [HOUR, released(["42", "expired"])]]);
  assert.deepEqual(linesOf({ journal: before }), [`${WAKES}: 0`, `${CLOSED}: 0`], "the hold is at 25 hours, outside the window, so this window never saw it held");
  assert.deepEqual(linesOf({ journal: journalOf([[HOUR, released(["42", "closed"])]]) }), [`${WAKES}: 0`, `${CLOSED}: 0`], "a release with no hold is not a wake");
});

test("a PR held and released twice is one wake, and two PRs held and released are two", () => {
  const twice = journalOf([[5 * HOUR, holding("42")], [4 * HOUR, released(["42", "closed"])], [3 * HOUR, holding("42")], [HOUR, released(["42", "closed"])]]);
  assert.deepEqual(linesOf({ journal: twice }), [`${WAKES}: 1; first: 42`, `${CLOSED}: 0`]);
  const two = journalOf([[3 * HOUR, holding("7", "8")], [HOUR, released(["7", "expired"], ["8", "unrecorded"])]]);
  assert.deepEqual(linesOf({ journal: two }), [`${WAKES}: 2; first: 7, 8`, `${CLOSED}: 0`]);
});

test("a shared-failure row closed as not the same failure inside the window reads 1; the same row without that comment reads 0", () => {
  const closed = [closedRow(900, HOUR, NOT_SAME)];
  assert.deepEqual(linesOf({ closedSharedRows: closed }), [`${WAKES}: 0`, `${CLOSED}: 1; first: #900`]);
  assert.deepEqual(linesOf({ closedSharedRows: [closedRow(900, HOUR, "Closed: fixed on main.")] }), [`${WAKES}: 0`, `${CLOSED}: 0`],
    "a closure with no 'not the same failure' comment is a fix, not a wrong grouping");
});

test("the closing comment is matched whatever its case, and a row closed outside the window is counted nowhere", () => {
  assert.deepEqual(linesOf({ closedSharedRows: [closedRow(900, HOUR, "NOT THE SAME FAILURE")] }), [`${WAKES}: 0`, `${CLOSED}: 1; first: #900`]);
  assert.deepEqual(linesOf({ closedSharedRows: [closedRow(900, 25 * HOUR, NOT_SAME)] }), [`${WAKES}: 0`, `${CLOSED}: 0`], "closed at 25 hours, before the window");
});

test("a count nobody could read is unknown, never 0", () => {
  assert.deepEqual(linesOf({ journal: null, closedSharedRows: null }), [
    `${WAKES}: unknown (the journal could not be read)`,
    `${CLOSED}: unknown (the closed shared-failure rows could not be read)`,
  ]);
});

test("one closure files an incident through the failure ledger, and the same window without it files none", () => {
  const filed = reportOf({ closedSharedRows: [closedRow(900, HOUR, NOT_SAME)] }).sharedFailures;
  const logPath = join(tmpDir("shared-failure-retro-"), FAILURE_LEDGER_FILE);
  const result = recordFailures({ logPath, events: retro_0.sharedFailureEvents(filed), now: NOW, report: () => {} });
  assert.equal(result.appended, 1, "one incident for the one closure");
  const [classKey, , ref] = readFileSync(logPath, "utf8").trimEnd().split("\t");
  assert.deepEqual([classKey, ref], [retro_0.SHARED_FAILURE_NOT_SAME_KIND, "#900"], "the ledger line names the kind and the row");

  const quiet = join(tmpDir("shared-failure-retro-quiet-"), FAILURE_LEDGER_FILE);
  const none = reportOf({ closedSharedRows: [] }).sharedFailures;
  assert.deepEqual(retro_0.sharedFailureEvents(none), [], "no closure and no wake is no event");
  assert.equal(recordFailures({ logPath: quiet, events: retro_0.sharedFailureEvents(none), now: NOW, report: () => {} }).appended, 0);
  assert.equal(existsSync(quiet), false, "the same window without the closure writes nothing to the ledger");
});

test("a held-then-released PR files an incident too, and a window with neither files none", () => {
  const journal = journalOf([[2 * HOUR, holding("42")], [HOUR, released(["42", "closed"])]]);
  const events = retro_0.sharedFailureEvents(reportOf({ journal }).sharedFailures);
  assert.deepEqual(events, [{ classKey: retro_0.SHARED_FAILURE_HELD_KIND, ref: `42 ${new Date(NOW - HOUR).toISOString().slice(0, 10)}` }]);
  assert.deepEqual(retro_0.sharedFailureEvents(reportOf({ journal: "" }).sharedFailures), []);
});

test("the gate writes the lines this count reads, in the words it reads them with", () => {
  const gate = readFileSync(new URL("./ci-failure-class.ts", import.meta.url), "utf8");
  assert.ok(gate.includes("ci-shared-failure: holding ${out.held.length} red order(s) of a shared failure:"), "the hold line");
  assert.ok(gate.includes("ci-shared-failure: released ${out.released.length} red order(s), their hold is over:"), "the release line");
  assert.ok(gate.includes("${r.subject} (${r.why})"), "a released subject with its reason in brackets");
  assert.equal(holding("42"), "ci-shared-failure: holding 1 red order(s) of a shared failure: 42");
  assert.equal(released(["42", "closed"]), "ci-shared-failure: released 1 red order(s), their hold is over: 42 (closed)");
});

test("the retro files both counts through recordFailures in dailyRetrospective, and reads the closed rows in its own class", () => {
  const src = moduleSource("org-retro.ts");
  assert.match(src, /recordFailures\(\{[^}]*events: sharedFailureEvents\(report\.sharedFailures\)/);
  assert.match(src, /name: "closed shared-failure rows"/);
});

test("a closed row whose comments run past the first page is refused, so its closing comment is never missed as 0", () => {
  const raw = (comments: object) => [{ number: 900, closedAt: new Date(NOW - HOUR).toISOString(), comments }];
  const whole = raw({ totalCount: 1, nodes: [{ body: NOT_SAME }] });
  assert.deepEqual(retro_2.readableClosedSharedRows(whole as any)?.map((row) => row.comments), [[{ body: NOT_SAME }]], "one page holds every comment: counted");
  const past = Array.from({ length: 100 }, () => ({ body: "Closed: fixed on main." }));
  assert.equal(retro_2.readableClosedSharedRows(raw({ totalCount: 101, nodes: past }) as any), null, "101 comments, 100 read: the closing comment may be the 101st");
  assert.equal(retro_2.readableClosedSharedRows(raw({ nodes: [{ body: NOT_SAME }] }) as any), null, "no count of comments means the read cannot be checked");
  const ceiling = Array.from({ length: 500 }, (_, i) => ({ number: i, closedAt: null, comments: { totalCount: 0, nodes: [] } }));
  assert.equal(retro_2.readableClosedSharedRows(ceiling as any), null, "500 rows is the list's ceiling, refused");
});
