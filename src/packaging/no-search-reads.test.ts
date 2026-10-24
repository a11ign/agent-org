// no-token: GH_READS -- #5050. Importing anything from `work-gate.ts` reaches `defaultRun` (`execFileSync("gh", ...)`), and this file never lets it run: every reader answers from the fake code host's rows
// (or, in the two fold cases, from an injected `run`), and the source guard reads files and spawns nothing.
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
 * A11-160 (step 9): WHAT GITHUB IS ASKED AND HOW ITS ANSWER IS READ ARE THE PLUGIN'S. The cases that fed a `run` that refused any search argv and answered GitHub's GraphQL connections moved to the plugin's tests
 * (`plugins/github/rows/rows-by-label.test.ts` for the claim's and the gate's by-label, closed and recently-closed reads and the refusal memory they share, `plugins/github/rows/rows-since-windows.test.ts` for the windows),
 * where the stubbed answers are fed to the real operations. What stays here is what CORE decides from the rows the code host gives it, held over the fake code host's rows, and the source guards.
 *
 * Claims, each with a case that can fail:
 *   1. BEHAVIOUR: `lookupClaimedRegions` answers from the code host's rows, and a read that fails is `null`, never `[]` (NEGATIVE CONTROL);
 *   2. A read refused for a limit is asked ONCE in a tick, and the line it leaves names WHICH resource (the plugin's: `rows-by-label.test.ts`);
 *   3. SOURCE: no file on the claim path builds a `issue list` / `pr list` argv carrying `--label` or `--search`; the guard SEES a fixture that
 *      does and passes one that does not;
 *   4. (#5050) EVERY LIST THE GATE READS answers from the code host's rows, and one that fails is `null` (the plugin's half: every one answers a `run` that refuses any search argv, and a read the
 *      limit refused is NOT asked again by ANY other list read of the tick, whichever kind);
 *   5. (#5050) SOURCE, widened: the gate's own files (`work-gate.ts`, `queue-table.ts`, `work-tick.ts`, `work-gate/`) are walked by the same guard.
 *   6. (#5074) SOURCE, widened again: the two other MEASURED spenders, `wake.ts` (the tick's three lists, run in-process) and `row-file.ts` (the filing's duplicate-title
 *      check), are walked, and each still lists something (a plain list), so the walk reads a file that lists. Their behaviour is pinned in
 *      `stuck-row-reask-filed.test.ts` (a search argv is refused there) and `row-file-board.test.ts`.
 *   7. (#5076) SOURCE, widened a third time, and BEHAVIOUR: the twelve other readers of the table in #5074 are walked, each reads through `ticket-port/rows-by-label.ts` or
 *      `rows-since.ts` (a marker that is tested in BOTH directions), and the readers of a window and of a label answer from the code host's rows. (That the window reader answers a `run` that
 *      refuses every search argv, pages to the first row before its window, REFUSES a window longer than its pages and sits under the one refusal memory is the plugin's: `rows-since-windows.test.ts`.)
 */
import { moduleSource } from "../lib/source-text-reads.ts";
import { test, afterEach } from "node:test";
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
import { fetchReadyIssueNumbers } from "../board-snapshot.ts";
import { ghReadyReader } from "../untiered-ready-rows.ts";
import { forgetActivation, substituteCodeHost } from "../plugins/active.ts";
import { fakePull } from "../plugins/fakes/code-host-pulls.ts";
import { mergedPrsInWindow } from "../close-rows-sweep.ts";
import { createFakeCodeHost } from "../plugins/fakes/code-host.ts";
import { fakeRow } from "../plugins/fakes/code-host-rows.ts";
import { readClosedRows } from "../trace/haiku-tier-report.ts";
import { readMergedSince } from "../org-retro/retro-window-and-journal-patterns.ts";
import { workGateSource } from "../lib/work-gate-source.ts";
import { connectionOf, readsRowsByLabel } from "./rows-by-label-fixtures.ts";

const TRACKER = "a11ign/a11ign";
const SRC = join(dirname(fileURLToPath(import.meta.url)), "..");
const LIMIT_TEXT = "GraphQL: API rate limit already exceeded for installation ID 170075049";

/** The fake code host holding `rows` as the tracker's rows (a held row is open and `in-progress`, with a Region block and a blocker), installed for the case. */
function trackerHolding(...held: { number: number; file: string; labels?: string[] }[]) {
  const host = createFakeCodeHost();
  for (const { number, file, labels = ["in-progress"] } of held) {
    host.rowsWorld.rows.set(number, fakeRow(host.rowsWorld, number, { labels, body: `## Region\n\n\`\`\`\n${file}\n\`\`\`\n`, blockedBy: [number + 1] }));
  }
  substituteCodeHost(host);
  return host.rowsWorld;
}
const ROOT = new Set(["src"]);
afterEach(() => forgetActivation());

// --- 1. behaviour: what the claim and the gate DECIDE from the rows the code host gives them ------------------------------------------------------

test("POSITIVE CONTROL: the claim reads who holds what from the code host's rows -- the file each holds and what blocks it (that the read is no search is the plugin's: rows-by-label.test.ts)", () => {
  trackerHolding({ number: 5032, file: "src/work-gate.ts" }, { number: 948, file: "src/queue-table.ts" }, { number: 77, file: "src/other.ts", labels: ["ready"] });
  const regions = lookupClaimedRegions({ repo: TRACKER, rootFiles: ROOT });
  assert.deepEqual(regions, [
    { number: 5032, files: ["src/work-gate.ts"], blockedBy: [5033] },
    { number: 948, files: ["src/queue-table.ts"], blockedBy: [949] },
  ], "the rows that hold a claim, and not the one that is only ready");
});

test("NEGATIVE CONTROL: a read that fails is `null`, never `[]` -- and a tracker nobody holds a file in is `[]`, a different value", () => {
  const world = trackerHolding({ number: 1, file: "src/a.ts" });
  world.failures.set("readClaimedRows", new Error("gh: 502"));
  assert.equal(lookupClaimedRegions({ repo: TRACKER, rootFiles: ROOT }), null, "a refused read is inconclusive");
  world.failures.set("readClaimedRows", new Error(LIMIT_TEXT));
  assert.equal(lookupClaimedRegions({ repo: TRACKER, rootFiles: ROOT }), null, "and a refusal for a limit too");
  world.failures.delete("readClaimedRows");
  world.rows.clear();
  assert.deepEqual(lookupClaimedRegions({ repo: TRACKER, rootFiles: ROOT }), [], "control: nobody holding a file IS `[]` when the read succeeded -- the two answers are different values");
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

/** The moved readers (A11-160): the GitHub plugin's rows, which `ticket-port/` now delegates to, and which hold the argv the walk above can no longer see there. */
const PLUGIN_ROWS = join(SRC, "..", "plugins", "github", "rows");

test("NEGATIVE CONTROL (source, A11-160): no reader the plugin holds for row mode builds a list argv carrying `--label` or `--search`", () => {
  const files = readdirSync(PLUGIN_ROWS).filter((file) => file.endsWith(".ts") && !file.endsWith(".test.ts"));
  assert.ok(files.includes("rows-by-label.ts") && files.includes("rows-since.ts"), "the walk sees the two connection readers: an empty walk would pass for the wrong reason");
  for (const file of files) assert.deepEqual(searchBackedLists(readFileSync(join(PLUGIN_ROWS, file), "utf8")), [], `plugins/github/rows/${file} lists rows through a SEARCH`);
});

test("POSITIVE CONTROL (source, #5074): `wake.ts` and `row-file.ts` are walked, and each still lists rows -- with a plain list, which is no search", () => {
  assert.ok(COVERED.includes("wake.ts") && COVERED.includes("row-file.ts"), "the walk sees the two files this row converted");
  // A11-160 (step 7): both lists are the code host's now, asked by name from the files that wait on a titled row and that check a filing's duplicate title; the plugin's rows hold the `issue list`, which the walk above reads.
  const asked: Record<string, { by: string; call: RegExp; in: string }> = {
    "wake/merge-queue-wait.ts": { by: "openRowsOf", call: /rows\(\)\.openRowsOf\(/, in: "gate-pull-reads.ts" },
    "row-file/issue-body-and-region-checks.ts": { by: "newestOpenRowsText", call: /newestOpenRowsText\(/, in: "filing-rows.ts" },
  };
  for (const [file, { by, call, in: plugin }] of Object.entries(asked)) {
    assert.match(moduleSource(file), call, `${file} asks the code host for its list by name (${by})`);
    assert.match(readFileSync(join(PLUGIN_ROWS, plugin), "utf8"), /\["issue", "list", /, `${plugin} still names an \`issue list\`, so the guard is looking at a file that lists`);
  }
});

test("POSITIVE CONTROL (source, #5050): the gate's list reads are SEEN by the walk -- `work-gate.ts` still names `issue list`, so the walk is reading a file that lists", () => {
  const gate = workGateSource();
  // A11-160 (step 6): the whole open list's argument list is the code host's now, in the plugin's rows, which the walk above reads.
  assert.match(readFileSync(join(PLUGIN_ROWS, "gate-pull-reads.ts"), "utf8"), /\["issue", "list", "--state", "open", "--limit"/, "the whole open list is still an `issue list` (it is no search), so the guard is looking at real list calls");
  assert.match(gate, /rows\(\)\.openRowsOf\(/, "and the gate asks the code host for it by name");
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

/** The `run` a gate reader is handed when the code host acts on its own rows: a call to it would be a call to a `gh` nobody has. */
const noGh = (args: string[]): string => { throw new Error(`no gh is run here: ${args.join(" ")}`); };

/** The gate's readers, each with the one call it makes, so a test can drive them all through one code host. */
const GATE_READS: { name: string; read: () => unknown; }[] = [
  { name: "readChairmanBlocked", read: () => readChairmanBlocked(noGh) },
  { name: "readPromotableRows", read: () => readPromotableRows(noGh) },
  { name: "readReadyRows", read: () => readReadyRows(noGh) },
  { name: "readClaimedRowComments", read: () => readClaimedRowComments(noGh, TRACKER) },
  { name: "readClosedClaimLabelRows", read: () => readClosedClaimLabelRows((args) => noGh(args), [undefined]).rows },
  { name: "readClosedAnswerRows", read: () => readClosedAnswerRows(noGh) },
  { name: "readRecentlyClosed", read: () => readRecentlyClosed(noGh) },
];

/** The tracker as the gate reads it: an open row on every lane it lists, and a closed row carrying a claim label and an answer label. */
function trackerOfTheGate() {
  const host = createFakeCodeHost();
  const { rowsWorld: world } = host;
  world.rows.set(7, fakeRow(world, 7, { labels: ["ready", "backlog", "needs:chairman", "in-progress"] }));
  world.rows.set(3, fakeRow(world, 3, { state: "CLOSED", closedAt: "2026-10-11T10:00:00Z", labels: ["in-progress", "answer:ceo"] }));
  substituteCodeHost(host);
  return world;
}

test("POSITIVE CONTROL: every list the gate reads answers from the code host's rows (that none is a search is the plugin's: rows-by-label.test.ts)", () => {
  trackerOfTheGate();
  for (const { name, read } of GATE_READS) assert.notEqual(read(), null, `${name} answered`);
  assert.deepEqual((readReadyRows(noGh) ?? []).map((row) => row.number), [7], "the ready list is the open rows carrying `ready`");
  assert.deepEqual((readClaimedRowComments(noGh, TRACKER) ?? []).map((row) => row.number), [7], "and the claimed rows' comments are those of the open rows carrying the claim label");
});

test("NEGATIVE CONTROL: a gate list read that FAILS is `null`, never `[]` -- for every reader", () => {
  for (const { name, read } of GATE_READS) {
    const world = trackerOfTheGate();
    for (const operation of ["readRowsByLabel", "closedRowsCarryingLabels", "labelNamesWithPrefix", "recentlyClosedRowsOf", "closedClaimedRowsOf"]) world.failures.set(operation, new Error("gh: 502"));
    assert.equal(read(), null, `${name} answers null for a failed read`);
  }
});

// --- the fold, at the edge of one connection page --------------------------------------------------------------------------------------
// A11-160 (step 9): LEFT ON A STUBBED `run` -- the first wave's fold (`foldIntoOpenRows`, `answerFromOpenRows` in `work-gate/reads/read-memo-and-exit.ts`) is CORE'S EXECUTOR: it reads the by-label call's argument list and
// re-renders the open list's JSON as the connection's answer, so the case can only be reached by feeding it GitHub's wire format. The fake code host's reads carry no argument list to fold.

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
/** A file reads through the connection readers when it imports them, or (since A11-160 moved them into the plugin) asks the code host's rows, whose reads of rows by label and of windows are the connection readers (`plugins/github/rows/rows-by-label.ts`, `rows-since.ts`). */
const CONNECTION_IMPORT = /from "(?:\.\.?\/)+(?:ticket-port\/rows-(?:by-label|since)|plugins\/rows)\.ts"/;
const readsThroughConnections = (source: string): boolean => CONNECTION_IMPORT.test(source);

test("POSITIVE CONTROL (source, #5076): the twelve are walked, and each reads through a connection reader -- the marker is tested with the import there and with it removed", () => {
  assert.ok(TWELVE.every((file) => COVERED.includes(file)), "the guard walks all twelve");
  assert.equal(new Set(TWELVE).size, 12, "twelve distinct files: an empty or short list would pass for the wrong reason");
  for (const file of TWELVE) {
    const source = moduleSource(file);
    assert.ok(readsThroughConnections(source), `${file} reads through ticket-port/rows-by-label.ts or rows-since.ts, or asks the code host's rows`);
    const without = source.replace(/^import .*(?:ticket-port\/rows-(?:by-label|since)|plugins\/rows)\.ts.*$/gm, "");
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

const SINCE_ISO = "2026-10-11T10:00:00.000Z";
const SINCE_MS = Date.parse(SINCE_ISO);
const ago = (minutes: number): string => new Date(SINCE_MS + minutes * 60_000).toISOString();

test("POSITIVE CONTROL: the readers of a window and of a label answer from the code host's rows (that none is a search is the plugin's: rows-by-label.test.ts, rows-since-windows.test.ts)", () => {
  const host = createFakeCodeHost();
  const { rowsWorld: world } = host;
  // Three pull requests: merged inside the retro's window, merged days before it though commented on inside it, and merged before it.
  const merged = (number: number, mergedAt: string, updatedAt: string) => fakePull(world, number, { merged: true, mergedAt, updatedAt, createdAt: mergedAt });
  merged(3, ago(30), ago(31));
  merged(2, ago(-90), ago(20));
  merged(1, ago(-300), ago(-299));
  // Three ready rows, and one row closed inside the Haiku report's window.
  for (const number of [1, 2, 3]) world.rows.set(number, fakeRow(world, number, { labels: ["ready"], comments: [] }));
  world.rows.set(9, fakeRow(world, 9, { state: "CLOSED", closedAt: ago(10), updatedAt: ago(10), labels: ["tier:haiku"] }));
  substituteCodeHost(host);
  try {
    assert.deepEqual(readClosedRows(SINCE_MS, SINCE_MS + 3_600_000).map((row) => [row.number, row.haiku]), [[9, true]], "the haiku report's closed rows answered: the row closed inside its window");
    assert.deepEqual(readClosedRows(SINCE_MS + 7_200_000, SINCE_MS + 10_800_000), [], "control: none was closed in a later window");
    assert.deepEqual((readMergedSince("a11ign/a11ign", SINCE_MS) as { number: number }[]).map((pr) => pr.number), [3], "the retrospective's merged list answered: only the row MERGED in the window");
    assert.deepEqual(fetchReadyIssueNumbers(), [3, 2, 1], "the board snapshot's ready list answered");
    assert.deepEqual(ghReadyReader({ key: "", repo: "a11ign/a11ign" }).listRows().map((row) => row.number), [3, 2, 1], "and the untiered count's");
    // The sweep's window read: a merge inside it, and none before it.
    const recently = new Date(Date.now() - 10 * 60_000).toISOString();
    merged(4, recently, recently);
    assert.deepEqual(mergedPrsInWindow("a11ign/a11ign", 45).map((pr) => pr.number), [4], "the sweep's window read answered");
  } finally {
    forgetActivation();
  }
});
