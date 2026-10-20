// no-token: GH_READS -- #5050. Importing anything from `work-gate.ts` reaches `defaultRun` (`execFileSync("gh", ...)`), and this file never lets it run: every reader is
// handed an injected `run` that answers from a fake, and the source guard reads files and spawns nothing.
/**
 * #5039: NO SEARCH-BACKED READ ON THE CLAIM PATH. #5050: NOR IN THE GATE, AND ONE REFUSAL IS ASKED ONCE PER TICK.
 *
 * `gh issue list --label X` (and `--search`) is sent by `gh` as a GitHub SEARCH, whose allowance is separate from and far smaller than the
 * GraphQL points. On 2026-10-11 the scheduler App's installation spent it and every claim was refused for it (`B4 COULD NOT BE ASKED`, eighteen
 * times in thirty minutes) while 3,948 points were left and a plain `gh api graphql` still worked. The claim's read of who holds what now reads
 * `repository.issues(labels:)`, a connection, which the search allowance does not govern.
 *
 * #5050 is the gate's half: `work-gate.ts` listed rows with `--label` and `--search` in eleven places, and the same installation spent the same allowance on them (1,620 list
 * calls in the 14:00Z hour, read from the workers' call ledger, 889 of them the gate's). Its label lists are now the same connection read; the closed rows owing an answer are
 * aliased connections; the newest-updated closed rows are `issues(orderBy: UPDATED_AT)`. `queue-table.ts` and `work-tick.ts` list nothing with a flag, and are walked all the same.
 *
 * Claims, each with a case that can fail:
 *   1. BEHAVIOUR: `lookupClaimedRegions` answers through a `run` that REFUSES any argv carrying `--label` or `--search` (POSITIVE CONTROL: the same
 *      fake answers the non-search read), and a read that fails is `null`, never `[]` (NEGATIVE CONTROL);
 *   2. A read refused for a limit is asked ONCE in a tick, and the line it leaves names WHICH resource;
 *   3. SOURCE: no file on the claim path builds a `issue list` / `pr list` argv carrying `--label` or `--search`; the guard SEES a fixture that
 *      does and passes one that does not;
 *   4. (#5050) EVERY LIST THE GATE READS answers through a `run` that refuses any search argv (POSITIVE CONTROL: the same fake answers the connection), and a read the
 *      limit refused is NOT asked again by ANY other list read of the tick, whichever kind;
 *   5. (#5050) SOURCE, widened: the gate's own files (`work-gate.ts`, `queue-table.ts`, `work-tick.ts`, `work-gate/`) are walked by the same guard.
 *   6. (#5074) SOURCE, widened again: the two other MEASURED spenders, `wake.ts` (the tick's three lists, run in-process) and `row-file.ts` (the filing's duplicate-title
 *      check), are walked, and each still lists something (a plain list), so the walk reads a file that lists. Their behaviour is pinned in
 *      `stuck-row-reask-filed.test.ts` (a search argv is refused there) and `row-file-board.test.ts`.
 *   7. (#5076) SOURCE, widened a third time, and BEHAVIOUR: the twelve other readers of the table in #5074 are walked, each reads through `ticket-port/rows-by-label.ts` or
 *      `rows-since.ts` (a marker that is tested in BOTH directions), and the new `rows-since.ts` reader answers a `run` that refuses every search argv, pages to the
 *      first row before its window, REFUSES a window longer than its pages, and sits under the one refusal memory.
 */
import { moduleSource } from "../lib/source-text-reads.ts";
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { lookupClaimedRegions } from "../row-claim/file-overlap-rule.ts";
import { readChairmanBlocked } from "../work-gate/causes/rows-chairman.ts";
import { readClaimedRowComments, readPromotableRows, readReadyRows } from "../work-gate/reads.ts";
import { readClosedAnswerRows } from "../work-gate/causes/rows-answers.ts";
import { readClosedClaimLabelRows } from "../work-gate/causes/rows-claims-closed.ts";
import { readRecentlyClosed } from "../work-gate/causes/rows-blocker-cleared.ts";
import { readTrackerLanes } from "../work-gate/tick.ts";
import { forgetRefusedReads, readClaimedRows, readRowsByLabel } from "../ticket-port/rows-by-label.ts";
import { foldPage, readMergedPullRequests, readRowsSince, SINCE_PAGE_SIZE, WindowCutShort, type SinceRead } from "../ticket-port/rows-since.ts";
import { mergedPrsInWindow } from "../close-rows-sweep.ts";
import { fetchReadyIssueNumbers } from "../board-snapshot.ts";
import { ghReadyReader } from "../untiered-ready-rows.ts";
import { readClosedRows } from "../trace/haiku-tier-report.ts";
import { readMergedSince } from "../org-retro/retro-cause.ts";
import { workGateSource } from "../lib/work-gate-source.ts";
import { closedAnswerConnection, connectionOf, readsClosedAnswerRows, readsRecentlyClosed, readsRowsByLabel, readsRowsSince, recentlyClosedConnection,
  sinceAnswer } from "./rows-by-label-fixtures.ts";

beforeEach(() => forgetRefusedReads());

const TRACKER = "a11ign/a11ign";
const SRC = join(dirname(fileURLToPath(import.meta.url)), "..");
const LIMIT_TEXT = "GraphQL: API rate limit already exceeded for installation ID 170075049";

const claimed = (number: number, file: string, labels: string[] = ["in-progress"]) => ({
  number, labels, body: `## Region\n\n\`\`\`\n${file}\n\`\`\`\n`, blockedBy: { nodes: [{ number: number + 1 }] },
});
const ROOT = new Set(["src"]);

/** The fake of the incident: any argv that is a search is refused in the words the installation was refused in; the connection answers. */
function searchRefusingRun(rows: ReturnType<typeof claimed>[]) {
  const calls: string[][] = [];
  const run = (args: string[]): string => {
    calls.push(args);
    if (args.includes("--label") || args.includes("--search")) throw new Error(LIMIT_TEXT);
    if (readsRowsByLabel(args)?.label === "in-progress") return connectionOf(rows);
    throw new Error(`unexpected call: ${args.join(" ")}`);
  };
  return { run, calls };
}

// --- 1. behaviour ---------------------------------------------------------------------------------------------------------------------

test("POSITIVE CONTROL: with every `--label` and `--search` argv refused, the claim still reads who holds what -- and the fake DOES refuse a search", () => {
  const { run, calls } = searchRefusingRun([claimed(5032, "src/work-gate.ts"), claimed(948, "src/queue-table.ts")]);
  assert.throws(() => run(["issue", "list", "--label", "in-progress"]), /rate limit already exceeded/, "the control: the fake is a refusing one, so a pass below is not a fake that accepts anything");
  calls.length = 0;
  const regions = lookupClaimedRegions({ run, repo: TRACKER, rootFiles: ROOT });
  assert.deepEqual(regions, [
    { number: 5032, files: ["src/work-gate.ts"], blockedBy: [5033] },
    { number: 948, files: ["src/queue-table.ts"], blockedBy: [949] },
  ]);
  assert.equal(calls.length, 1, "one read, and it is not a search");
  assert.ok(!calls[0].includes("--label") && !calls[0].includes("--search"));
  assert.ok(calls[0].includes("label=in-progress"), "the label is a variable of the connection, not a filter flag");
});

test("NEGATIVE CONTROL: a read that fails is `null`, never `[]` -- a refusal, a bad payload, and a list that is not the whole population", () => {
  assert.equal(lookupClaimedRegions({ run: () => { throw new Error(LIMIT_TEXT); }, repo: TRACKER, rootFiles: ROOT }), null);
  forgetRefusedReads();
  assert.equal(lookupClaimedRegions({ run: () => { throw new Error("gh: 502"); }, repo: TRACKER, rootFiles: ROOT }), null);
  assert.equal(lookupClaimedRegions({ run: () => "not json", repo: TRACKER, rootFiles: ROOT }), null);
  assert.equal(lookupClaimedRegions({ run: () => JSON.stringify({ errors: [{ message: "Could not resolve to a Repository" }] }), repo: TRACKER, rootFiles: ROOT }), null);
  assert.equal(lookupClaimedRegions({ run: () => connectionOf([claimed(1, "src/a.ts")], { hasNextPage: true }), repo: TRACKER, rootFiles: ROOT }), null,
    "a next page that is never read is a list cut short");
  assert.deepEqual(lookupClaimedRegions({ run: () => connectionOf([]), repo: TRACKER, rootFiles: ROOT }), [],
    "control: nobody holding a file IS `[]` when the read succeeded -- the two answers are different values");
});

test("the rows come back in the shape `gh issue list --json` gave, across pages, so no comparison had to change", () => {
  const pages = [connectionOf([claimed(1, "src/a.ts")], { hasNextPage: true }), connectionOf([claimed(2, "src/b.ts", ["in-progress", "session:worker-2"])])];
  const rows = readClaimedRows({ run: () => pages.shift() as string, repo: TRACKER });
  assert.deepEqual(rows.map((row) => row.number), [1, 2]);
  assert.deepEqual(rows[1].labels, [{ name: "in-progress" }, { name: "session:worker-2" }]);
  assert.deepEqual(rows[0].blockedBy, { nodes: [{ number: 2 }] });
});

// --- 2. a limit-refused read is asked once, and says which resource -----------------------------------------------------------------------

test("a read refused for a limit is asked ONCE in a tick, and the line names the resource it came from", () => {
  const calls: string[][] = [];
  const lines: string[] = [];
  const probe = "HTTP/2.0 200 OK\r\nX-Ratelimit-Limit: 5000\r\nX-Ratelimit-Remaining: 3948\r\nX-Ratelimit-Resource: graphql\r\n\r\n{}";
  const run = (args: string[]): string => {
    calls.push(args);
    if (readsRowsByLabel(args) !== null) throw new Error(LIMIT_TEXT);
    return probe; // the one follow-up read of the GraphQL pool, whose headers name the pool that answered
  };
  const first = readClaimedRows.bind(null, { run, repo: TRACKER, log: (line: string) => lines.push(line) });
  assert.throws(() => first(), /rate limit already exceeded/);
  assert.throws(() => first(), /not asked again this tick/);
  assert.throws(() => first(), /not asked again this tick/);
  assert.equal(calls.filter((args) => readsRowsByLabel(args) !== null).length, 1, "the refused read went to GitHub once; the second and third asks did not");
  assert.equal(lines.length, 1, "and said so once");
  assert.match(lines[0], /3948 of 5000 left/, "it names the pool it read, with the count");
  assert.match(lines[0], /a secondary limit: the installation was refused while its pool reads 3948 of 5000 left/, "and that an installation refused while its pool reads healthy is a secondary limit (#1523)");
  assert.match(lines[0], /installation ID 170075049/, "and keeps the one identifier the refusal carried");
});

test("a refusal that is not a limit is not remembered: the next ask goes to GitHub again", () => {
  let asked = 0;
  const run = (): string => { asked += 1; throw new Error("gh: 502"); };
  assert.equal(lookupClaimedRegions({ run, repo: TRACKER, rootFiles: ROOT }), null);
  assert.equal(lookupClaimedRegions({ run, repo: TRACKER, rootFiles: ROOT }), null);
  assert.equal(asked, 2);
});

// --- 3. the source guard ------------------------------------------------------------------------------------------------------------

/** The flags `gh issue list` / `gh pr list` turn into a SEARCH (#5050 adds the author and assignee the row names: `pr list --author` is one, and neither is needed by a read here). */
const SEARCH_FLAGS = new Set(["--label", "-l", "--search", "-S", "--author", "-A", "--assignee", "-a"]);

/** The call-shaped array literals that LIST rows with a search-backed flag: `["issue", "list", ..., "--label", ...]`. */
function searchBackedLists(source: string): string[] {
  const file = ts.createSourceFile("x.ts", source, ts.ScriptTarget.Latest, true);
  const found: string[] = [];
  const text = (node: ts.Node | undefined): string | null => (node !== undefined && ts.isStringLiteralLike(node) ? node.text : null);
  const visit = (node: ts.Node): void => {
    if (ts.isArrayLiteralExpression(node)) {
      const strings = node.elements.map(text);
      const lists = (strings[0] === "issue" || strings[0] === "pr") && strings[1] === "list";
      const flags = strings.filter((s) => s !== null && SEARCH_FLAGS.has(s));
      if (lists && flags.length > 0) found.push(`${strings[0]} list ${flags.join(" ")} (line ${file.getLineAndCharacterOfPosition(node.getStart()).line + 1})`);
    }
    ts.forEachChild(node, visit);
  };
  visit(file);
  return found;
}

/** The files the claim reads through: the claim, its rules, the sweep freeze beside them, the incident rows, and the port directory. */
const COVERED = [
  "row-claim.ts", "sweep-window.ts", "ci-failure-class.ts",
  // #5050: the gate. `work-gate.ts` is where eleven of them were; the other two list nothing with a flag and stay walked so the first one added is seen.
  "work-gate.ts", "queue-table.ts", "work-tick.ts",
  // #5074: the tick's wake and the filing tool.
  "wake.ts", "row-file.ts",
  // #5076: the twelve other readers of the table in #5074 (`fleet-gated-nightly.ts`, which lists through `work-gate.ts`'s selector, is its own row).
  "ready-label-audit.ts", "untiered-ready-rows.ts", "board-snapshot.ts", "board-data.ts", "close-rows-sweep.ts", "close-rows-for-merged-pr.ts", "hand-fix-ledger.ts", "dora.ts",
  "org-retro.ts", "provider-low-confidence.ts", "messaging/watch.ts", "trace/haiku-tier-report.ts",
  ...readdirSync(join(SRC, "work-gate"), { recursive: true, encoding: "utf8" }).filter((f) => f.endsWith(".ts") && !f.endsWith(".test.ts")).map((f) => `work-gate/${f}`),
  ...readdirSync(join(SRC, "row-claim"), { recursive: true, encoding: "utf8" }).filter((f) => f.endsWith(".ts") && !f.endsWith(".test.ts")).map((f) => `row-claim/${f}`),
  ...readdirSync(join(SRC, "ticket-port"), { recursive: true, encoding: "utf8" }).filter((f) => f.endsWith(".ts") && !f.endsWith(".test.ts")).map((f) => `ticket-port/${f}`),
];

test("NEGATIVE CONTROL (source): no file the claim or the gate reads through builds a list argv carrying `--label` or `--search`", () => {
  assert.ok(COVERED.includes("row-claim/file-overlap-rule.ts") && COVERED.includes("ticket-port/rows-by-label.ts"),
    "the walk sees the files this row converted: an empty walk would pass for the wrong reason");
  assert.ok(["work-gate.ts", "queue-table.ts", "work-tick.ts", "work-gate/org-health.ts"].every((file) => COVERED.includes(file)), "and the gate's own files (#5050)");
  for (const file of COVERED) assert.deepEqual(searchBackedLists(moduleSource(file)), [], `${file} lists rows through a SEARCH`);
});

test("POSITIVE CONTROL (source, #5074): `wake.ts` and `row-file.ts` are walked, and each still lists rows -- with a plain list, which is no search", () => {
  assert.ok(COVERED.includes("wake.ts") && COVERED.includes("row-file.ts"), "the walk sees the two files this row converted");
  for (const file of ["wake.ts", "row-file.ts"]) {
    assert.match(moduleSource(file), /\["issue", "list", /, `${file} still names an \`issue list\`, so the guard is looking at a file that lists`);
  }
});

test("POSITIVE CONTROL (source, #5050): the gate's list reads are SEEN by the walk -- `work-gate.ts` still names `issue list`, so the walk is reading a file that lists", () => {
  const gate = workGateSource();
  assert.match(gate, /\["issue", "list", "--state", "open", "--limit"/, "the whole open list is still an `issue list` (it is no search), so the guard is looking at real list calls");
  assert.doesNotMatch(gate, /"--label", (?:CHAIRMAN|BACKLOG|READY|CLAIM)_LABEL/, "and the four label lists it used to build are gone");
});

test("POSITIVE CONTROL (source): the guard sees a fixture that lists with `--label` or `--search`, and passes one that does not", () => {
  const label = `export const read = (run) => run(["issue", "list", "--repo", r, "--state", "open", "--label", "in-progress", "--json", "number"]);\n`;
  const search = `const read = (run) => run(["pr", "list", "--search", "merged:>=2026-10-01"]);\n`;
  assert.deepEqual(searchBackedLists(label), ['issue list --label (line 1)']);
  assert.deepEqual(searchBackedLists(search), ['pr list --search (line 1)']);
  assert.deepEqual(searchBackedLists(`const read = (run) => run(["pr", "list", "--author", "app/a11ign", "--json", "number"]);\n`), ['pr list --author (line 1)'],
    "#5050: an author filter on a list is a search too");
  assert.deepEqual(searchBackedLists(`const read = (run) => run(["issue", "list", "--repo", r, "--state", "open", "--json", "number"]);\n`), [], "a plain list is not a search");
  assert.deepEqual(searchBackedLists(`const make = (run) => run(["issue", "create", "--title", t, "--label", "shared-failure"]);\n`), [],
    "and a label on a WRITE is not a read: the guard names the list shape, not the flag");
});

// --- 4. the gate's lists, behaviour -------------------------------------------------------------------------------------------------

/** The gate's readers, each with the one call it makes, so a test can drive them all through one fake. */
const GATE_READS: { name: string; read: (run: (args: string[]) => string) => unknown; }[] = [
  { name: "readChairmanBlocked", read: (run) => readChairmanBlocked(run) },
  { name: "readPromotableRows", read: (run) => readPromotableRows(run) },
  { name: "readReadyRows", read: (run) => readReadyRows(run) },
  { name: "readClaimedRowComments", read: (run) => readClaimedRowComments(run, TRACKER) },
  { name: "readClosedClaimLabelRows", read: (run) => readClosedClaimLabelRows((args) => run(args), [undefined]).rows },
  { name: "readClosedAnswerRows", read: (run) => readClosedAnswerRows(run) },
  { name: "readRecentlyClosed", read: (run) => readRecentlyClosed(run) },
];

/** What a gate list read gets from a GitHub whose SEARCH allowance is spent: every `--label`/`--search` argv is refused in the incident's words, a connection answers. */
function gateGitHub({ failWith }: { failWith?: string; } = {}) {
  const calls: string[][] = [];
  const run = (args: string[]): string => {
    calls.push(args);
    if (failWith !== undefined) throw new Error(failWith);
    if (args.includes("--label") || args.includes("--search") && args[0] !== "label") throw new Error(LIMIT_TEXT);
    if (args[0] === "label") return JSON.stringify([{ name: "answer:ceo" }]);
    if (readsRowsByLabel(args) !== null) return connectionOf([claimed(7, "src/a.ts", ["ready", "backlog", "needs:chairman", "in-progress"])]);
    if (readsClosedAnswerRows(args) !== null) return closedAnswerConnection([]);
    if (readsRecentlyClosed(args)) return recentlyClosedConnection([{ number: 3, closedAt: "2026-10-11T10:00:00Z", updatedAt: "2026-10-11T10:00:00Z" }]);
    throw new Error(`unexpected call: ${args.join(" ")}`);
  };
  return { run, calls };
}

test("POSITIVE CONTROL: every list the gate reads answers while every `--label` and `--search` argv is refused -- and the fake DOES refuse one", () => {
  const { run, calls } = gateGitHub();
  assert.throws(() => run(["issue", "list", "--label", "ready"]), /rate limit already exceeded/, "the control: a pass below is not a fake that accepts anything");
  calls.length = 0;
  for (const { name, read } of GATE_READS) {
    forgetRefusedReads();
    const answer = read(run);
    assert.notEqual(answer, null, `${name} answered through connections`);
  }
  assert.ok(calls.length >= GATE_READS.length, "each reader asked");
  assert.deepEqual(calls.filter((args) => args.includes("--label") || (args.includes("--search") && args[0] !== "label")), [], "and none of them was a search");
});

test("NEGATIVE CONTROL: a gate list read that FAILS is `null`, never `[]` -- for every reader", () => {
  for (const { name, read } of GATE_READS) {
    forgetRefusedReads();
    const { run } = gateGitHub({ failWith: "gh: 502" });
    const answer = read(run);
    assert.ok(answer === null || (Array.isArray(answer) && answer.length === 0 && name === "readClosedAnswerRows") === false, `${name} is not an empty list from a failed read`);
    assert.equal(answer, null, `${name} answers null for a failed read`);
  }
});

test("a read refused for a LIMIT is asked ONCE in the tick: no other gate list read -- by label, closed answers or recently closed -- is sent, and the line names the resource", () => {
  const lines: string[] = [];
  const probe = "HTTP/2.0 200 OK\r\nX-Ratelimit-Limit: 5000\r\nX-Ratelimit-Remaining: 3948\r\nX-Ratelimit-Resource: graphql\r\n\r\n{}";
  const calls: string[][] = [];
  const run = (args: string[]): string => {
    calls.push(args);
    if (args[0] === "api" && args.includes("-i")) return probe;
    throw new Error(LIMIT_TEXT);
  };
  const write = process.stderr.write.bind(process.stderr);
  process.stderr.write = ((chunk: string) => { lines.push(String(chunk)); return true; }) as typeof process.stderr.write;
  try {
    assert.equal(readReadyRows(run), null, "the first read is refused: null");
    const asked = calls.length;
    for (const { read } of GATE_READS.filter(({ name }) => name !== "readReadyRows")) read(run);
    assert.equal(calls.length, asked, "and not one more call was sent by the other six readers");
  } finally {
    process.stderr.write = write;
  }
  const said = lines.filter((line) => line.startsWith("rows-by-label:"));
  assert.equal(said.length, 1, "the refusal is said once");
  assert.match(said[0], /OPEN rows labelled ready/);
  assert.match(said[0], /3948 of 5000 left/, "and names the pool it read");
});

test("the closed answer reads are under the SAME memory as the by-label ones: a refused closed read stops the next by-label read of the tick", () => {
  forgetRefusedReads();
  let refused = false;
  const calls: string[][] = [];
  const run = (args: string[]): string => {
    calls.push(args);
    if (args[0] === "label") return JSON.stringify([{ name: "answer:ceo" }]);
    if (readsClosedAnswerRows(args) !== null) { refused = true; throw new Error(LIMIT_TEXT); }
    throw new Error("unexpected call after the refusal");
  };
  const quiet = process.stderr.write.bind(process.stderr);
  process.stderr.write = (() => true) as typeof process.stderr.write;
  try {
    assert.equal(readClosedAnswerRows(run), null);
    const asked = calls.length;
    assert.equal(readChairmanBlocked(run), null, "and the by-label read, which would have thrown `unexpected call`, was never sent");
    assert.equal(calls.length, asked);
  } finally {
    process.stderr.write = quiet;
  }
  assert.ok(refused, "control: the closed read was the one that was refused");
});

// --- the fold, at the edge of one connection page --------------------------------------------------------------------------------------

/** A backlog row as the open list gives it (`gh issue list --json`). */
const backlogRow = (number: number) => ({ number, title: `row ${number}`, createdAt: "2026-10-01T00:00:00Z", updatedAt: "2026-10-02T00:00:00Z", body: "", milestone: null,
  labels: [{ name: "backlog" }], blockedBy: { nodes: [] }, subIssuesSummary: { total: 0, completed: 0 } });

/** A GitHub that answers the whole open list and the by-label connection (paged, 100 a page), and counts the by-label reads it was SENT. */
function trackerWithBacklog(count: number) {
  const open = Array.from({ length: count }, (_, at) => backlogRow(count - at));
  const sent: string[][] = [];
  const answer = (args: string[]): string => {
    if (args[0] === "issue" && args[1] === "list") return JSON.stringify(open);
    const asked = readsRowsByLabel(args);
    if (asked === null) throw new Error(`unexpected call: ${args.join(" ")}`);
    sent.push(args);
    if (asked.label !== "backlog") return connectionOf([]);
    const after = args.find((arg) => arg.startsWith("after="));
    const page = after === undefined ? open.slice(0, 100) : open.slice(100);
    return connectionOf(page, { hasNextPage: after === undefined && open.length > 100 });
  };
  const run = (args: string[]): string => answer(args);
  const batch = (calls: { args: string[]; }[]) => calls.map(({ args }) => ({ stdout: answer(args) }));
  return { run, batch, sent };
}

test("the fold answers a label from the open list when it fits ONE page of the connection: the by-label read is not sent (POSITIVE CONTROL)", () => {
  const { run, batch, sent } = trackerWithBacklog(40);
  const lanes = readTrackerLanes(run, batch as never);
  assert.equal(lanes.promotableRows?.length, 40, "all forty backlog rows came back");
  assert.deepEqual(sent.filter((args) => readsRowsByLabel(args)?.label === "backlog"), [], "and the connection was never asked: they were made from the open list");
});

test("a label with MORE rows than one page of the connection is NOT answered from the open list: it is asked, and no row past the first page is lost", () => {
  const { run, batch, sent } = trackerWithBacklog(150);
  const lanes = readTrackerLanes(run, batch as never);
  assert.equal(lanes.promotableRows?.length, 150, "the hundred and fifty rows: a first page folded and called whole would have returned 100");
  assert.ok(sent.some((args) => readsRowsByLabel(args)?.label === "backlog"), "the connection WAS asked, because the open list cannot say there is no second page");
});

// --- 7. (#5076) the twelve other readers, and the reader that serves a window ----------------------------------------------------------------------------------

/** The twelve files of the table in #5074 that are neither the gate's nor `wake.ts`'s or `row-file.ts`'s. `fleet-gated-nightly.ts` lists through `work-gate.ts`'s selector and is its own row. */
const TWELVE = ["ready-label-audit.ts", "untiered-ready-rows.ts", "board-snapshot.ts", "board-data.ts", "close-rows-sweep.ts", "close-rows-for-merged-pr.ts", "hand-fix-ledger.ts",
  "dora.ts", "org-retro.ts", "provider-low-confidence.ts", "messaging/watch.ts", "trace/haiku-tier-report.ts"];

/** Does this source read rows through one of the two connection readers? A marker, and tested in both directions below. */
const readsThroughConnections = (source: string): boolean => /from "(?:\.\.?\/)+ticket-port\/rows-(?:by-label|since)\.ts"/.test(source);

test("POSITIVE CONTROL (source, #5076): the twelve are walked, and each reads through a connection reader -- the marker is tested with the import there and with it removed", () => {
  assert.ok(TWELVE.every((file) => COVERED.includes(file)), "the guard walks all twelve");
  assert.equal(new Set(TWELVE).size, 12, "twelve distinct files: an empty or short list would pass for the wrong reason");
  for (const file of TWELVE) {
    const source = moduleSource(file);
    assert.ok(readsThroughConnections(source), `${file} reads through ticket-port/rows-by-label.ts or rows-since.ts`);
    const without = source.replace(/^import .*ticket-port\/rows-(?:by-label|since)\.ts.*$/gm, "");
    assert.equal(readsThroughConnections(without), false, `the marker notices the import gone from ${file}: it is not a marker that passes whatever is there`);
  }
});

test("NEGATIVE CONTROL (source, #5076): a `--label` or `--search` list added to any of the twelve is SEEN by the walk", () => {
  for (const file of TWELVE) {
    const source = moduleSource(file);
    assert.deepEqual(searchBackedLists(source), [], `${file} lists nothing through a search today`);
    const mutated = `${source}\nexport const regress = (run) => run(["issue", "list", "--repo", r, "--state", "open", "--label", "ready", "--json", "number"]);\n`;
    assert.equal(searchBackedLists(mutated).length, 1, `${file} with a \`--label\` list appended turns the guard red`);
  }
});

/** A GitHub whose SEARCH allowance is spent: every `--label`/`--search` argv is refused in the incident's words, and the two connection reads answer from `rows`. */
function searchSpentGitHub(rows: Record<string, unknown>[]) {
  const calls: string[][] = [];
  const run = (args: string[]): string => {
    calls.push(args);
    if (args.includes("--label") || args.includes("--search")) throw new Error(LIMIT_TEXT);
    if (readsRowsSince(args) !== null) return sinceAnswer(args, rows as never);
    if (readsRowsByLabel(args) !== null) return connectionOf(rows as never);
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

test("POSITIVE CONTROL: the converted readers answer while every search argv is refused -- and the fake DOES refuse one", () => {
  const rows = [pull(3, { merged: ago(30), updated: ago(31) }), pull(2, { merged: ago(-90), updated: ago(20) }), pull(1, { merged: ago(-300), updated: ago(-299) })];
  const { run, calls } = searchSpentGitHub(rows);
  assert.throws(() => run(["pr", "list", "--search", "merged:>=2026-10-11"]), /rate limit already exceeded/, "the control: a pass below is not a fake that accepts anything");
  calls.length = 0;
  const merged = mergedPrsInWindow("a11ign/a11ign", 45, run);
  assert.ok(Array.isArray(merged), "the sweep's window read answered");
  assert.ok(calls.length >= 1 && calls.every((args) => !args.includes("--search") && !args.includes("--label")), "and none of its calls was a search");
  assert.deepEqual(readClosedRows(SINCE_MS, SINCE_MS + 3_600_000, (args) => run(args)).length, 0, "the haiku report's closed rows answered (no closed row in the fake is in range)");
  assert.equal(readMergedSince("a11ign/a11ign", SINCE_MS, (args) => JSON.parse(run(args)))?.length, 1, "the retrospective's merged list answered: only the row MERGED in the window");
  assert.deepEqual(fetchReadyIssueNumbers({ run: (_cmd, args) => run(args) }), [3, 2, 1], "the board snapshot's ready list answered, from the by-label connection");
  assert.deepEqual(ghReadyReader({ key: "", repo: "a11ign/a11ign" }, run).listRows().map((row) => row.number), [3, 2, 1], "and the untiered count's");
});

test("a read refused for a limit stops every other window read of the tick, and one that is not a limit does not (the shared refusal memory)", () => {
  forgetRefusedReads();
  const lines: string[] = [];
  const probe = "HTTP/2.0 200 OK\r\nX-Ratelimit-Limit: 5000\r\nX-Ratelimit-Remaining: 3948\r\nX-Ratelimit-Resource: graphql\r\n\r\n{}";
  const calls: string[][] = [];
  const refusing = (args: string[]): string => { calls.push(args); if (args.includes("-i")) return probe; throw new Error(LIMIT_TEXT); };
  const ask: SinceRead = { kind: "pullRequests", states: ["MERGED"], orderBy: "UPDATED_AT", repo: TRACKER, select: "number mergedAt", since: SINCE_ISO };
  assert.throws(() => readRowsSince({ ask, run: refusing, log: (line) => lines.push(line) }), /rate limit already exceeded/);
  const asked = calls.length;
  assert.throws(() => readRowsSince({ ask, run: refusing }), /not asked again this tick/);
  assert.throws(() => readRowsByLabel({ label: "ready", state: "OPEN", select: "number", run: refusing }), /not asked again this tick/, "a by-label read is under the same memory");
  assert.equal(calls.length, asked, "no call was sent after the refusal");
  assert.equal(lines.length, 1);
  assert.match(lines[0], /the pullRequests of a11ign\/a11ign \(MERGED\), since 2026-10-11T10:00:00.000Z/, "and the line names what was asked");
  forgetRefusedReads();
  assert.throws(() => readRowsSince({ ask, run: () => { throw new Error("gh: 502"); } }), /502/);
  assert.doesNotThrow(() => readRowsSince({ ask, run: (args) => sinceAnswer(args, []) }), "a refusal that is not a limit is not remembered: the next ask goes through");
});

test("the window ends at the first row before it, and no page past that is asked", () => {
  const inside = Array.from({ length: 120 }, (_, i) => pull(1000 - i, { merged: ago(200 - i), updated: ago(200 - i) }));
  const older = [pull(7, { merged: ago(-500), updated: ago(-500) }), pull(6, { merged: ago(-600), updated: ago(-600) })];
  const { run, calls } = searchSpentGitHub([...inside, ...older, ...older, ...older]);
  const rows = readRowsSince({ ask: { kind: "pullRequests", states: ["MERGED"], orderBy: "UPDATED_AT", repo: TRACKER, select: "number", since: SINCE_ISO }, run });
  assert.equal(rows.length, 120, "every row of the window, none of the older ones");
  assert.equal(calls.length, 2, "two pages: the second held the first older row, so a third was never asked");
  assert.equal(rows.every((row) => Date.parse(row.updatedAt) >= SINCE_MS), true);
});

test("NEGATIVE CONTROL: a window longer than its pages is REFUSED, never returned in part -- and `newest` is the one that truncates, by its own name", () => {
  const all = Array.from({ length: 3 * SINCE_PAGE_SIZE }, (_, i) => pull(5000 - i, { merged: ago(500 - i), updated: ago(500 - i) }));
  const { run } = searchSpentGitHub(all);
  const ask: SinceRead = { kind: "pullRequests", states: ["MERGED"], orderBy: "UPDATED_AT", repo: TRACKER, select: "number", since: SINCE_ISO };
  assert.throws(() => readRowsSince({ ask: { ...ask, maxPages: 2 }, run }), (error: Error) => error instanceof WindowCutShort && /may be cut short/.test(error.message));
  assert.equal(readRowsSince({ ask: { ...ask, maxPages: 3 }, run }).length, 300, "control: three pages hold it, and then it is read whole");
  assert.equal(readRowsSince({ ask: { kind: "pullRequests", states: ["MERGED"], orderBy: "CREATED_AT", repo: TRACKER, select: "number", newest: 150 }, run }).length, 150, "`newest` stops at its count");
  assert.throws(() => readRowsSince({ ask: { ...ask, since: undefined as never }, run }), /needs `since` or `newest`/, "and a read bounded by neither is refused");
  assert.throws(() => readRowsSince({ ask: { ...ask, since: "yesterday-ish" }, run }), /is not a time/);
  assert.throws(() => foldPage({ ask: { ...ask, maxPages: 1 }, rows: [], page: { nodes: [{ updatedAt: SINCE_ISO }], hasNextPage: true, endCursor: "c" }, pagesRead: 1 }), WindowCutShort);
});

test("a payload that is not a connection THROWS: `could not read` is never an empty window", () => {
  const ask: SinceRead = { kind: "issues", states: ["CLOSED"], orderBy: "UPDATED_AT", repo: TRACKER, select: "number closedAt", since: SINCE_ISO };
  assert.throws(() => readRowsSince({ ask, run: () => JSON.stringify({ errors: [{ message: "Could not resolve to a Repository" }] }) }), /did not come back as a connection: Could not resolve/);
  forgetRefusedReads();
  assert.throws(() => readRowsSince({ ask, run: () => "not json" }));
  assert.deepEqual(readRowsSince({ ask, run: (args) => sinceAnswer(args, []) }), [], "control: an empty window that WAS read is `[]`");
});

test("merged pull requests are kept by their own `mergedAt` and `base`: a row merely UPDATED in the window, or merged elsewhere, is not a merge in it", () => {
  const rows = [
    pull(4, { merged: ago(50), updated: ago(50) }),
    pull(3, { merged: ago(30), updated: ago(40), base: "release" }),
    pull(2, { merged: ago(-3000), updated: ago(20) }),
  ];
  const { run } = searchSpentGitHub(rows);
  const got = readMergedPullRequests({ repo: TRACKER, select: "number", run, window: { since: SINCE_ISO }, base: "main" });
  assert.deepEqual(got.map((row) => row.number), [4], "the one merged into `main` inside the window");
  assert.deepEqual(readMergedPullRequests({ repo: TRACKER, select: "number", run, window: { since: SINCE_ISO } }).map((row) => row.number), [4, 3],
    "control: without `base` the release merge is in, and the one merged days ago and commented on today is out");
});
