// no-token: none -- `run` answers from a recorded table: no GitHub CLI runs
/**
 * #5076 (A11-160, step 9, moved from `src/packaging/no-search-reads.test.ts`, whose `run` stubs fed GitHub's GraphQL connection pages to core's window readers): THE READER THAT SERVES A WINDOW OF ROWS, AND THE SEARCH
 * ALLOWANCE IT NEVER SPENDS. A merged or closed list is `repository.pullRequests(states:)` or `repository.issues(states:)`, a connection ordered newest first and paged 100 at a time; where it stops, what it refuses and
 * what a refusal for a limit does to the next read are the plugin's, so the pages are fed to the real operations here. What a caller makes of the rows (the sweep's window, the retro's merged list, the Haiku report's
 * closed rows) is core's, and its tests run over the fake code host's rows.
 */
import { beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import type { RowsHelpers, SinceRead } from "../../../src/plugins/contracts/code-host-rows.ts";
import { rowsReadHelpers } from "../../../src/plugins/rows-light-helpers.ts";
import { WindowCutShort } from "../../../src/ticket-port/window-cut-short.ts";
import { connectionOf, readsRowsByLabel, readsRowsSince, sinceAnswer } from "../../../src/packaging/rows-by-label-fixtures.ts";
import { createRows } from "./index.ts";
import { SINCE_PAGE_SIZE } from "./rows-since.ts";

const rows = () => createRows(() => rowsReadHelpers() as unknown as RowsHelpers);
const TRACKER = "a11ign/a11ign";
const LIMIT_TEXT = "GraphQL: API rate limit already exceeded for installation ID 170075049";

beforeEach(() => rows().forgetRefusedReads());

/** A GitHub whose SEARCH allowance is spent: every `--label`/`--search` argv is refused in the incident's words, and the two connection reads answer from `held`. */
function searchSpentGitHub(held: Record<string, unknown>[]) {
  const calls: string[][] = [];
  const run = (args: string[]): string => {
    calls.push(args);
    if (args.includes("--label") || args.includes("--search")) throw new Error(LIMIT_TEXT);
    if (readsRowsSince(args) !== null) return sinceAnswer(args, held as never);
    if (readsRowsByLabel(args) !== null) return connectionOf(held as never);
    throw new Error(`unexpected call: ${args.join(" ")}`);
  };
  return { run, calls };
}
const SINCE_ISO = "2026-10-11T10:00:00.000Z";
const SINCE_MS = Date.parse(SINCE_ISO);
const ago = (minutes: number): string => new Date(SINCE_MS + minutes * 60_000).toISOString();
/** A pull request as a fake writes it: updated at `updated`, merged at `merged` (null for one that was not), into `base`. */
const pull = (number: number, { merged, updated, base = "main" }: { merged: string | null; updated: string; base?: string; }) =>
  ({ number, mergedAt: merged, updatedAt: updated, baseRefName: base, labels: [], files: [] });
const MERGED_PULLS: SinceRead = { kind: "pullRequests", states: ["MERGED"], orderBy: "UPDATED_AT", repo: TRACKER, select: "number mergedAt", since: SINCE_ISO };

test("POSITIVE CONTROL: the window readers answer while every search argv is refused -- and the fake DOES refuse one", () => {
  const held = [pull(3, { merged: ago(30), updated: ago(31) }), pull(2, { merged: ago(-90), updated: ago(20) }), pull(1, { merged: ago(-300), updated: ago(-299) })];
  const { run, calls } = searchSpentGitHub(held);
  assert.throws(() => run(["pr", "list", "--search", "merged:>=2026-10-11"]), /rate limit already exceeded/, "the control: a pass below is not a fake that accepts anything");
  calls.length = 0;
  // The sweep's window read (`mergedPrsInWindow` asks for exactly this request).
  const merged = rows().readMergedPullRequests({ repo: TRACKER, select: "number", run, base: "main", window: { since: new Date(Date.now() - 45 * 60_000).toISOString() } });
  assert.ok(Array.isArray(merged), "the sweep's window read answered");
  assert.ok(calls.length >= 1 && calls.every((args) => !args.includes("--search") && !args.includes("--label")), "and none of its calls was a search");
  // The Haiku report's closed rows are a window of CLOSED rows by `updatedAt`; the retro's merged list is `readMergedPullRequests` with a `maxPages`.
  assert.ok(Array.isArray(rows().readRowsSince({ ask: { kind: "issues", states: ["CLOSED"], orderBy: "UPDATED_AT", repo: TRACKER, select: "number closedAt", since: SINCE_ISO }, run })), "the haiku report's closed rows answered");
  assert.equal(rows().readMergedPullRequests({ repo: TRACKER, select: "number createdAt", run, window: { since: SINCE_ISO, maxPages: 10 } }).length, 1, "the retrospective's merged list answered: only the row MERGED in the window");
  assert.deepEqual(rows().readRowsByLabel({ label: "ready", state: "OPEN", select: "number", repo: TRACKER, run }).map((row) => row.number), [3, 2, 1], "the board snapshot's ready list answered, from the by-label connection");
  assert.ok(calls.every((args) => !args.includes("--search") && !args.includes("--label")), "and none of those was a search either");
});

test("a read refused for a limit stops every other window read of the tick, and one that is not a limit does not (the shared refusal memory)", () => {
  const lines: string[] = [];
  const probe = "HTTP/2.0 200 OK\r\nX-Ratelimit-Limit: 5000\r\nX-Ratelimit-Remaining: 3948\r\nX-Ratelimit-Resource: graphql\r\n\r\n{}";
  const calls: string[][] = [];
  const refusing = (args: string[]): string => { calls.push(args); if (args.includes("-i")) return probe; throw new Error(LIMIT_TEXT); };
  assert.throws(() => rows().readRowsSince({ ask: MERGED_PULLS, run: refusing, log: (line) => lines.push(line) }), /rate limit already exceeded/);
  const asked = calls.length;
  assert.throws(() => rows().readRowsSince({ ask: MERGED_PULLS, run: refusing }), /not asked again this tick/);
  assert.throws(() => rows().readRowsByLabel({ label: "ready", state: "OPEN", select: "number", run: refusing }), /not asked again this tick/, "a by-label read is under the same memory");
  assert.equal(calls.length, asked, "no call was sent after the refusal");
  assert.equal(lines.length, 1);
  assert.match(lines[0], /the pullRequests of a11ign\/a11ign \(MERGED\), since 2026-10-11T10:00:00.000Z/, "and the line names what was asked");
  rows().forgetRefusedReads();
  assert.throws(() => rows().readRowsSince({ ask: MERGED_PULLS, run: () => { throw new Error("gh: 502"); } }), /502/);
  assert.doesNotThrow(() => rows().readRowsSince({ ask: MERGED_PULLS, run: (args) => sinceAnswer(args, []) }), "a refusal that is not a limit is not remembered: the next ask goes through");
});

test("the window ends at the first row before it, and no page past that is asked", () => {
  const inside = Array.from({ length: 120 }, (_, i) => pull(1000 - i, { merged: ago(200 - i), updated: ago(200 - i) }));
  const older = [pull(7, { merged: ago(-500), updated: ago(-500) }), pull(6, { merged: ago(-600), updated: ago(-600) })];
  const { run, calls } = searchSpentGitHub([...inside, ...older, ...older, ...older]);
  const found = rows().readRowsSince({ ask: { ...MERGED_PULLS, select: "number" }, run });
  assert.equal(found.length, 120, "every row of the window, none of the older ones");
  assert.equal(calls.length, 2, "two pages: the second held the first older row, so a third was never asked");
  assert.equal(found.every((row) => Date.parse(row.updatedAt) >= SINCE_MS), true);
});

test("NEGATIVE CONTROL: a window longer than its pages is REFUSED, never returned in part -- and `newest` is the one that truncates, by its own name", () => {
  const all = Array.from({ length: 3 * SINCE_PAGE_SIZE }, (_, i) => pull(5000 - i, { merged: ago(500 - i), updated: ago(500 - i) }));
  const { run } = searchSpentGitHub(all);
  const ask: SinceRead = { ...MERGED_PULLS, select: "number" };
  assert.throws(() => rows().readRowsSince({ ask: { ...ask, maxPages: 2 }, run }), (error: Error) => error instanceof WindowCutShort && /may be cut short/.test(error.message));
  assert.equal(rows().readRowsSince({ ask: { ...ask, maxPages: 3 }, run }).length, 300, "control: three pages hold it, and then it is read whole");
  assert.equal(rows().readRowsSince({ ask: { kind: "pullRequests", states: ["MERGED"], orderBy: "CREATED_AT", repo: TRACKER, select: "number", newest: 150 }, run }).length, 150, "`newest` stops at its count");
  assert.throws(() => rows().readRowsSince({ ask: { ...ask, since: undefined as never }, run }), /needs `since` or `newest`/, "and a read bounded by neither is refused");
  assert.throws(() => rows().readRowsSince({ ask: { ...ask, since: "yesterday-ish" }, run }), /is not a time/);
  assert.throws(() => rows().foldPage({ ask: { ...ask, maxPages: 1 }, rows: [], page: { nodes: [{ updatedAt: SINCE_ISO }], hasNextPage: true, endCursor: "c" }, pagesRead: 1 }), WindowCutShort);
});

test("a payload that is not a connection THROWS: `could not read` is never an empty window", () => {
  const ask: SinceRead = { kind: "issues", states: ["CLOSED"], orderBy: "UPDATED_AT", repo: TRACKER, select: "number closedAt", since: SINCE_ISO };
  assert.throws(() => rows().readRowsSince({ ask, run: () => JSON.stringify({ errors: [{ message: "Could not resolve to a Repository" }] }) }), /did not come back as a connection: Could not resolve/);
  rows().forgetRefusedReads();
  assert.throws(() => rows().readRowsSince({ ask, run: () => "not json" }));
  assert.deepEqual(rows().readRowsSince({ ask, run: (args) => sinceAnswer(args, []) }), [], "control: an empty window that WAS read is `[]`");
});

test("merged pull requests are kept by their own `mergedAt` and `base`: a row merely UPDATED in the window, or merged elsewhere, is not a merge in it", () => {
  const held = [
    pull(4, { merged: ago(50), updated: ago(50) }),
    pull(3, { merged: ago(30), updated: ago(40), base: "release" }),
    pull(2, { merged: ago(-3000), updated: ago(20) }),
  ];
  const { run } = searchSpentGitHub(held);
  const got = rows().readMergedPullRequests({ repo: TRACKER, select: "number", run, window: { since: SINCE_ISO }, base: "main" });
  assert.deepEqual(got.map((row) => row.number), [4], "the one merged into `main` inside the window");
  assert.deepEqual(rows().readMergedPullRequests({ repo: TRACKER, select: "number", run, window: { since: SINCE_ISO } }).map((row) => row.number), [4, 3],
    "control: without `base` the release merge is in, and the one merged days ago and commented on today is out");
});
